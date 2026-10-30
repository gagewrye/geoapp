import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { nodataPossible, seedWindows } from "../../../src/core/seed";
import type { Affine, Grid } from "../../../src/core/types";
import { exportLabels } from "../../../src/io/labelExport";
import type { LabelSource } from "../../../src/io/labelFile";
import { baseTile } from "../../../src/io/maskBase";
import { importLabels } from "../../../src/io/seeding";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import { footprint } from "../../../src/core/pixel";
import { idle } from "../helpers/paintQueue";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource, recordingSink } from "../helpers/sources";

// Spec 021 criteria 1 (progress per window per pass), 6 (a read failure partway, io) and 9 (the imagery read skipped).

const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
const GRID: Grid = { width: 1000, height: 700, epsg: 32633, gt };
const maskValue = (c: number, r: number) => (c >= 800 ? 0 : 1 + ((c >> 5) + (r >> 5)) % 3);
const TABLE = [1, 2, 3].map((v) => ({ value: v, name: `v${v}` }));

/** Imagery on GRID with these nodata and float flags, counting imagery reads; band 0 is 7 everywhere (never nodata). */
function imageryOf(nodata: number | null, float: boolean) {
  const img = fakeSource({ ...GRID, bandCount: 2, nodata, float }, () => 7);
  return { imagery: img.source, reads: img.reads };
}

describe("nodataPossible (criterion 9, core)", () => {
  it("is true when nodata is set or samples are floating point", () => {
    expect(nodataPossible(null, false)).toBe(false);
    expect(nodataPossible(0, false)).toBe(true);
    expect(nodataPossible(null, true)).toBe(true);
    expect(nodataPossible(-1, true)).toBe(true);
  });
});

describe("onProgress (criterion 1)", () => {
  for (const table of [TABLE, null]) {
    it(`is called once per window, done 1..total in order (one pass, spec 024) (${table ? "table" : "no table"})`, async () => {
      const { imagery } = imageryOf(null, true);
      const file = fakeLabelSource(GRID, maskValue).source;
      const calls: [number, number][] = [];
      const r = await importLabels(imagery, file, table, undefined, (done, total) => calls.push([done, total]));
      expect(typeof r).toBe("object");
      const total = seedWindows(GRID, GRID).length; // one pass (spec 024)
      expect(calls).toEqual(Array.from({ length: total }, (_, i) => [i + 1, total]));
    });
  }

  it("stops calling once stale, with no window after the next read", async () => {
    const { imagery } = imageryOf(null, true);
    const f = fakeLabelSource(GRID, maskValue);
    let cancelled = false;
    const calls: number[] = [];
    const r = await importLabels(imagery, f.source, TABLE, () => cancelled, (done) => { calls.push(done); if (done === 3) cancelled = true; });
    expect(r).toBe("stale");
    expect(calls).toEqual([1, 2, 3]);
    const windows = seedWindows(GRID, GRID).slice(0, 4).map((w) => `${w.x0},${w.y0}`);
    expect(f.reads.every((w) => windows.includes(`${w.x0},${w.y0}`))).toBe(true);
  });
});

describe("a read failure partway (criterion 6, io)", () => {
  it("rejects with the read's error, after some progress", async () => {
    const { imagery } = imageryOf(null, true);
    const f = fakeLabelSource(GRID, maskValue).source;
    let n = 0;
    const err = Object.assign(new Error("gone"), { name: "NotFoundError" });
    const file: LabelSource = { ...f, read: (w) => (++n === 4 ? Promise.reject(err) : f.read(w)) };
    const calls: number[] = [];
    await expect(importLabels(imagery, file, TABLE, undefined, (d) => calls.push(d))).rejects.toBe(err);
    expect(calls).toEqual([1, 2, 3]);
  });
});

describe("the imagery read skipped (criterion 9)", () => {
  const ws = tileWindows(GRID.width, GRID.height);

  async function run(nodata: number | null, float: boolean) {
    const { imagery, reads } = imageryOf(nodata, float);
    const file = fakeLabelSource(GRID, maskValue).source;
    const r = await importLabels(imagery, file, TABLE);
    if (typeof r === "string") throw new Error(r);
    const importReads = reads.length;
    const tiles: Uint8Array[] = [];
    for (const w of ws) tiles.push((await baseTile(imagery, r.base, w)).labels);
    const tileReads = reads.length - importReads;
    const sink = recordingSink();
    await exportLabels(imagery, r.store, r.classes, sink.sink, r.base);
    return { importReads, tileReads, exportReads: reads.length - importReads - tileReads, tiles, bytes: sink.bytes(), pixels: r.pixels };
  }

  it("makes no imagery reads with nodata null and integer samples, with byte-equal tiles", async () => {
    const skipped = await run(null, false), read = await run(null, true);
    expect([skipped.importReads, skipped.tileReads, skipped.exportReads]).toEqual([0, 0, 0]);
    expect(read.importReads).toBeGreaterThan(0);
    expect(read.tileReads).toBeGreaterThan(0);
    expect(read.exportReads).toBeGreaterThan(0);
    expect(skipped.pixels).toBe(read.pixels);
    skipped.tiles.forEach((t, i) => expect(Buffer.from(t).equals(Buffer.from(read.tiles[i]!))).toBe(true));
    expect(Buffer.from(skipped.bytes).equals(Buffer.from(read.bytes))).toBe(true);
  });

  it("reads as before with nodata set, or with float samples", async () => {
    for (const [nd, fl] of [[0, false], [null, true], [-1, true]] as const) {
      const r = await run(nd, fl);
      expect(r.importReads).toBeGreaterThan(0);
      expect(r.tileReads).toBeGreaterThan(0);
      expect(r.exportReads).toBeGreaterThan(0);
    }
  });

  it("a copy-on-touch tile (an erase cell on the mask) reads no imagery, and holds the mask's labels", async () => {
    for (const float of [false, true]) {
      const { imagery, reads } = imageryOf(null, float);
      const r = await importLabels(imagery, fakeLabelSource(GRID, maskValue).source, TABLE);
      if (typeof r === "string") throw new Error(r);
      reads.length = 0;
      const store = r.store;
      const q = new PaintQueue(imagery, () => store, { applied: () => {}, full: () => {}, busy: () => {}, error: (e) => { throw e; } }, undefined, () => r.base);
      q.push(cellOp(footprint(store, 10, 10, 1)!, 1, true));
      await idle(q);
      expect(reads.length).toBe(float ? 1 : 0);
      const want = (await baseTile(imagery, r.base, ws[0]!)).labels;
      want[10 * 256 + 10] = 0;
      expect(Buffer.from(store.tiles.get("0,0")!).equals(Buffer.from(want))).toBe(true);
    }
  });
});
