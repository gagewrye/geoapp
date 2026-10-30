import { describe, expect, it } from "vitest";
import type { Affine, Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import { importLabels } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Spec 014 criterion 4: a mask over far more than 256 tiles imports as a base, tile by tile.

const SIDE = 8192; // 32 x 32 = 1024 tiles
const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
const GRID: Grid = { width: SIDE, height: SIDE, epsg: 32633, gt };
const inNodata = (c: number, r: number) => c >= 1000 && c < 1100 && r >= 3000 && r < 3050; // 5000 px, inside one tile
const key = (w: { x0: number; y0: number; width: number; height: number }) => `${w.x0},${w.y0},${w.width},${w.height}`;

/** Equal-grid imagery and a fully labelled mask, both computed on demand, logging reads and the most in flight per source. */
function instrumented() {
  const fileReads: string[] = [], imageryReads: string[] = [];
  const flight = { f: 0, i: 0, maxF: 0, maxI: 0 };
  const img = fakeSource({ ...GRID, bandCount: 1, nodata: -9999 }, (_b, c, r) => (inNodata(c, r) ? -9999 : 1)).source;
  const imagery: RasterSource = {
    meta: img.meta,
    async readWindow(x0, y0, w, h) {
      imageryReads.push(key({ x0, y0, width: w, height: h }));
      flight.maxI = Math.max(flight.maxI, ++flight.i);
      await Promise.resolve();
      try { return await img.readWindow(x0, y0, w, h); } finally { flight.i--; }
    },
  };
  const f = fakeLabelSource(GRID, () => 1).source;
  const file: LabelSource = {
    ...f,
    async read(w) {
      fileReads.push(key(w));
      flight.maxF = Math.max(flight.maxF, ++flight.f);
      await Promise.resolve();
      try { return await f.read(w); } finally { flight.f--; }
    },
  };
  return { imagery, file, fileReads, imageryReads, flight };
}

describe("a large mask (criterion 4)", () => {
  it("an 8192 x 8192 fully labelled mask imports with Replace, storing no tile, reading each window once, one read at a time", { timeout: 300_000 }, async () => {
    const io = instrumented();
    const r = await importLabels(io.imagery, io.file, [{ value: 1, name: "one" }]);
    if (typeof r === "string") throw new Error(r);
    expect(r.store.tiles.size).toBe(0);
    expect(r.store.base).toBe(true);
    expect(r.pixels).toBe(SIDE * SIDE - 5000);
    expect(r.base.count).toBe(SIDE * SIDE - 5000);
    expect(r.classes.map((c) => c.name)).toEqual(["one"]);
    const aligned = (k: string) => { const [x0, y0, w, h] = k.split(",").map(Number) as [number, number, number, number]; return x0 % 256 === 0 && y0 % 256 === 0 && w <= 256 && h <= 256; };
    expect(io.fileReads).toHaveLength(1024);
    expect(new Set(io.fileReads).size).toBe(1024);
    expect(io.fileReads.every(aligned)).toBe(true);
    // spec 024: imagery validity comes a row band at a time, each pixel read once, each read within one band
    const rows = io.imageryReads.map((k) => k.split(",").map(Number) as [number, number, number, number]);
    expect(rows.every(([, y0, , h]) => y0 % 256 === 0 && h <= 256)).toBe(true);
    expect(rows.reduce((a, [, , w, h]) => a + w * h, 0)).toBe(SIDE * SIDE);
    expect(new Set(io.imageryReads).size).toBe(io.imageryReads.length);
    expect([io.flight.maxF, io.flight.maxI]).toEqual([1, 1]);
  });
});

describe("an import while a mask is loaded (spec 014 Rules, spec 017)", () => {
  it("replaces the base and the classes", { timeout: 60_000 }, async () => {
    const g: Grid = { width: 600, height: 300, epsg: 32633, gt };
    const imagery = fakeSource({ ...g, bandCount: 1 }, () => 1);
    const file = fakeLabelSource(g, () => 4);
    const first = await importLabels(imagery.source, file.source, [{ value: 4, name: "four" }]);
    if (typeof first === "string") throw new Error(first);
    const again = await importLabels(imagery.source, file.source, [{ value: 4, name: "again" }]);
    if (typeof again === "string") throw new Error(again);
    expect(again.classes.map((c) => c.name)).toEqual(["again"]);
    expect(again.base).not.toBe(first.base);
    expect(again.store.tiles.size).toBe(0);
  });
});
