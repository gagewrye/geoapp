import { describe, expect, it } from "vitest";
import { initialClasses, type LabelClass } from "../../../src/core/classes";
import type { ClassEntry } from "../../../src/core/classTable";
import { tileWindows, type Window } from "../../../src/core/grid";
import { emptyStore } from "../../../src/core/labelStore";
import type { Affine, Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import { importLabels, type Labels, type SeedOutcome } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Spec 004's import build and memory rule: the current labels are never written (spec 017: imports
// build new labels), every read is one aligned window of at most 256x256 with one in flight, and a
// stale run stops reading.

const GT: Affine = [500000, 10, 0, 5000000, 0, -10];
const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };

/** A deep copy of labels, to compare against after a run. */
const snapshot = (l: Labels) => ({ keys: [...l.store.tiles.keys()], arrays: [...l.store.tiles.values()], bytes: [...l.store.tiles.values()].map((t) => t.slice()), classes: structuredClone(l.classes) });
function expectUntouched(l: Labels, s: ReturnType<typeof snapshot>) {
  expect([...l.store.tiles.keys()]).toEqual(s.keys);
  [...l.store.tiles.values()].forEach((t, i) => { expect(t).toBe(s.arrays[i]); expect(t).toEqual(s.bytes[i]); });
  expect(l.classes).toEqual(s.classes);
}

/** Labels with `n` stored tiles (row-major from 0,0) on a size x size grid, each holding value 1 on its first pixel only. */
function labelsWith(n: number, size: number, classes: LabelClass[] = initialClasses()): Labels {
  const store = emptyStore(size, size);
  for (const w of tileWindows(size, size).slice(0, n)) { const t = new Uint8Array(w.width * w.height); t[0] = 1; store.tiles.set(`${w.x0},${w.y0}`, t); }
  return { store, classes };
}

describe("the current labels are never written", () => {
  const g: Grid = { width: 1024, height: 1024, epsg: 32633, gt: GT };
  const imagery = () => fakeSource({ ...g, bandCount: 1 }, () => 1).source;
  const file = (f: (c: number, r: number) => number = () => 3) => fakeLabelSource(g, f).source;
  const table: ClassEntry[] = [{ value: 3, name: "three" }];

  it("success, \"empty\" and \"stale\" leave the current store, its tile arrays and the list unchanged (imports only build new labels)", { timeout: 30_000 }, async () => {
    const cur = labelsWith(5, 1024);
    const s = snapshot(cur);
    const r = ok(await importLabels(imagery(), file(), table));
    expectUntouched(cur, s);
    expect(r.store).not.toBe(cur.store);
    expect(r.store.tiles).not.toBe(cur.store.tiles);
    expect(await importLabels(imagery(), fakeLabelSource(g, () => 255, 255).source, [{ value: 9, name: "absent" }])).toBe("empty"); // only nodata (spec 047: other values are Class v)
    expectUntouched(cur, s);
    let calls = 0;
    expect(await importLabels(imagery(), file(), table, () => ++calls > 3)).toBe("stale");
    expectUntouched(cur, s);
  });
});

/** Wraps sources so every read is logged with its window and the most reads in flight at once is tracked. */
function instrument(imagery: RasterSource, file: LabelSource) {
  const log: { kind: "i" | "f"; w: Window }[] = [];
  let inFlight = 0, max = 0;
  const track = async <T>(kind: "i" | "f", w: Window, read: () => Promise<T>) => {
    log.push({ kind, w });
    max = Math.max(max, ++inFlight);
    await Promise.resolve();
    try { return await read(); } finally { inFlight--; }
  };
  return {
    log, max: () => max,
    imagery: { meta: imagery.meta, readWindow: (x0: number, y0: number, width: number, height: number) => track("i", { x0, y0, width, height }, () => imagery.readWindow(x0, y0, width, height)) } as RasterSource,
    file: { ...file, read: (w: Window) => track("f", w, () => file.read(w)) } as LabelSource,
  };
}
const aligned = (w: Window) => w.x0 % 256 === 0 && w.y0 % 256 === 0 && w.width >= 1 && w.width <= 256 && w.height >= 1 && w.height <= 256;

describe("memory, structurally", () => {
  it("a small file on a 65536 x 65536 imagery reads only aligned <= 256 x 256 windows near the file, one at a time", { timeout: 60_000 }, async () => {
    const big: Grid = { width: 65536, height: 65536, epsg: 32633, gt: [400000, 10, 0, 5300000, 0, -10] };
    const f: Grid = { width: 700, height: 500, epsg: 4326, gt: [15.0, 0.0002, 0, 45.0, 0, -0.0002] };
    const { source: img } = fakeSource({ ...big, bandCount: 2 }, () => 1);
    const io = instrument(img, fakeLabelSource(f, () => 6).source);
    ok(await importLabels(io.imagery, io.file, null));
    expect(io.max()).toBe(1);
    expect(io.log.filter((e) => e.kind === "f").every((e) => aligned(e.w))).toBe(true);
    // spec 024: imagery validity a row band at a time, over the windows the file covers (about 5 x 5 windows)
    const imageryReads = io.log.filter((e) => e.kind === "i");
    expect(imageryReads.every((e) => e.w.y0 % 256 === 0 && e.w.height <= 256 && e.w.x0 % 256 === 0)).toBe(true);
    expect(new Set(imageryReads.map((e) => `${e.w.x0},${e.w.y0}`)).size).toBe(imageryReads.length);
    expect(imageryReads.reduce((a, e) => a + e.w.width * e.w.height, 0)).toBeLessThan(60 * 65536);
    expect(io.log.filter((e) => e.kind === "f").length).toBeLessThan(400);
  });

  it("a stale run reads nothing more once stale", { timeout: 30_000 }, async () => {
    const g: Grid = { width: 2048, height: 2048, epsg: 32633, gt: GT };
    const io = instrument(fakeSource({ ...g, bandCount: 1 }, () => 1).source, fakeLabelSource(g, () => 4).source);
    // stale from the 5th read on (a raster opened meanwhile); on equal grids each imagery window needs one file window
    expect(await importLabels(io.imagery, io.file, null, () => io.log.length >= 5)).toBe("stale");
    expect(io.log).toHaveLength(5);
    const later = instrument(fakeSource({ ...g, bandCount: 1 }, () => 1).source, fakeLabelSource(g, () => 4).source);
    // one pass (spec 024): a row's 8 file reads, its imagery span, then the next row's; stale at that row's third file read
    expect(await importLabels(later.imagery, later.file, null, () => later.log.length >= 8 + 1 + 3)).toBe("stale");
    expect(later.log.map((e) => e.kind)).toEqual([...Array(8).fill("f"), "i", "f", "f", "f"]);
  });
});

