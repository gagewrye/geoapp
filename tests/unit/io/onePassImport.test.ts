import { describe, expect, it, vi } from "vitest";
import type { ClassEntry } from "../../../src/core/classTable";
import { decodedBytes, MAX_READ_BYTES, type Block } from "../../../src/core/imagery";
import { applyAffine } from "../../../src/core/crs";
import { emptyStore } from "../../../src/core/labelStore";
import { seedWindows, sourceCells } from "../../../src/core/seed";
import type { Grid } from "../../../src/core/types";
import { rowBandReader, type LabelSource } from "../../../src/io/labelFile";
import { effectiveTile, gridOf } from "../../../src/io/maskBase";
import { MaskCache } from "../../../src/io/maskCache";
import { importLabels } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { yieldToBrowser } from "../../../src/io/yieldTask";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource, samplesSource } from "../helpers/sources";
import { twoPassImport } from "../helpers/twoPassImport";

// Spec 024 criteria 2 (one pass equals spec 004's two), 3 (label file strips decoded once) and 4 (imagery from the mask cache).

const GRID: Grid = { width: 1000, height: 700, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
const at = (dx: number, dy: number, w: number, h: number, size = 10): Grid => {
  const [x, y] = applyAffine(GRID.gt, dx, dy);
  return { width: w, height: h, epsg: 32633, gt: [x, size, 0, y, 0, -size] };
};
/** Criterion 2's imagery: 3 x 2 windows, partial on both edges, so the matrix below stays fast without losing a case. */
const SMALL: Grid = { ...GRID, width: 520, height: 300 };
const FILES: [string, Grid][] = [
  ["the imagery grid", SMALL],
  ["a shifted equal grid", at(130, 75, 300, 200)],
  ["a sub-pixel shift", at(130.4, 75, 300, 200)],
  ["a coarser grid", at(-40, 20, 40, 30, 17)],
  ["EPSG:4326", { width: 300, height: 200, epsg: 4326, gt: [15.0, 0.0002, 0, 45.12, 0, -0.0002] }],
];
/** Pseudo-random per pixel, so masks have no pattern a bug could hide in. */
const hash = (c: number, r: number, k = 0) => (((c * 73856093) ^ (r * 19349663) ^ (k * 83492791)) >>> 0) % 997;
const fileValue = (c: number, r: number) => (hash(c, r, 1) % 23 === 0 ? 9 : ((c >> 6) + (r >> 5)) % 4); // 9 is rare: some only under nodata
const IMAGERY: [string, (g?: Grid) => RasterSource][] = [
  ["nodata 0 on 1-row strips", (g = SMALL) => samplesSource({ ...g, bandCount: 2, nodata: 0, float: false, alpha: null }, (k, c, r) => (hash(c, r, k) % 7 === 0 ? 0 : 3), { width: g.width, height: 1, bytes: 2 * g.width }).source],
  ["alpha on 256 px tiles", (g = SMALL) => samplesSource({ ...g, bandCount: 4, nodata: null, float: false, alpha: 3 }, (k, c, r) => (k === 3 ? (c > 400 || hash(c, r) % 5 === 0 ? 0 : 255) : 9), { width: 256, height: 256, bytes: 256 * 256 * 4 }).source],
  ["no nodata possible, readWindow only", (g = SMALL) => fakeSource({ ...g, bandCount: 2, nodata: null, float: false }, () => 4).source],
  ["NaN floats, readWindow only", (g = SMALL) => fakeSource({ ...g, bandCount: 1, nodata: null, float: true }, (_k, c, r) => (hash(c, r) % 11 === 0 ? NaN : 1)).source],
];
const TABLES: [string, ClassEntry[] | null][] = [
  ["no table", null],
  ["a table", [{ value: 1, name: "one" }, { value: 3, name: "three" }, { value: 9, name: "nine" }]],
];

describe("one pass equals spec 004's two passes (criterion 2)", () => {
  for (const [fname, fgrid] of FILES) for (const [iname, imagery] of IMAGERY) for (const [tname, table] of TABLES) for (const nodata of [null, 0]) {
    it(`${fname}, ${iname}, ${tname}, file nodata ${nodata}`, async () => {
      const img = imagery();
      const file = fakeLabelSource(fgrid, fileValue, nodata).source;
      const want = await twoPassImport(img, file, table);
      const calls: [number, number][] = [];
      const got = await importLabels(img, file, table, undefined, (d, t) => calls.push([d, t]));
      const n = seedWindows(gridOf(img.meta), gridOf(file.meta)).length;
      expect(calls).toEqual(Array.from({ length: n }, (_, i) => [i + 1, n]));
      if (typeof want === "string" || typeof got === "string") { expect(got).toBe(want); return; }
      expect(got.classes).toEqual(want.classes);
      expect(Array.from(got.base.lut)).toEqual(Array.from(want.lut));
      expect([got.pixels, got.base.count, got.classCount]).toEqual([want.count, want.count, want.classCount]);
      expect([...got.base.windows].sort()).toEqual([...want.windows].sort());
      expect(Buffer.from(got.base.preview.values).equals(Buffer.from(want.preview))).toBe(true);
    });
  }

  // an effective tile is a function of the file, LUT, labelled windows and imagery, all compared above; one case checks it whole
  it("effective tiles are byte-equal (a shifted equal grid, strips, no table)", async () => {
    const img = IMAGERY[0]![1](), file = fakeLabelSource(FILES[1]![1], fileValue, 0).source;
    const want = await twoPassImport(img, file, null), got = await importLabels(img, file, null);
    if (typeof want === "string" || typeof got === "string") throw new Error("no labels");
    const store = emptyStore(SMALL.width, SMALL.height);
    for (const w of seedWindows(SMALL, gridOf(file.meta))) {
      const a = await effectiveTile(img, store, got.base, w);
      const b = await effectiveTile(img, store, { ...got.base, lut: want.lut, windows: want.windows }, w);
      expect(Buffer.from(a).equals(Buffer.from(b)), `${w.x0},${w.y0}`).toBe(true);
    }
  });
});

describe("with no progress listener (criterion 2)", () => {
  it("gives the same result as with one", async () => {
    const [, imagery] = IMAGERY[0]!;
    const file = fakeLabelSource(FILES[1]![1], fileValue, 0).source;
    const a = await importLabels(imagery(), file, null), b = await importLabels(imagery(), file, null, undefined, () => {});
    if (typeof a === "string" || typeof b === "string") throw new Error("no labels");
    expect([...a.base.windows].sort()).toEqual([...b.base.windows].sort());
    expect([a.pixels, Buffer.from(a.base.preview.values).equals(Buffer.from(b.base.preview.values))]).toEqual([b.pixels, true]);
  });
});

describe("label file strips (criterion 3)", () => {
  it("on 1-row strips with an equal grid, each strip is decoded at most once, and every read decodes at most MAX_READ_BYTES", async () => {
    const g = at(0, 0, 1000, 700);
    const block: Block = { width: g.width, height: 1, bytes: g.width };
    const reads: { x0: number; y0: number; width: number; height: number }[] = [];
    const fake = fakeLabelSource(g, fileValue).source;
    const file: LabelSource = { ...fake, read: rowBandReader(g, block, async (w) => { reads.push({ ...w }); return fake.read(w); }) };
    const img = samplesSource({ ...GRID, bandCount: 1, nodata: 0, float: false, alpha: null }, () => 3, { width: 1000, height: 1, bytes: 1000 }).source;
    const r = await importLabels(img, file, null);
    expect(typeof r).not.toBe("string");
    const rows = new Map<number, number>();
    for (const w of reads) {
      expect(decodedBytes(w, block, g.width, g.height)).toBeLessThanOrEqual(MAX_READ_BYTES);
      for (let y = w.y0; y < w.y0 + w.height; y++) rows.set(y, (rows.get(y) ?? 0) + 1);
    }
    expect(rows.size).toBe(700);
    expect(Math.max(...rows.values())).toBe(1);
  });

  it("a band wider than MAX_READ_BYTES is read in pieces within it", async () => {
    const g: Grid = { width: 70_000, height: 300, epsg: 32633, gt: GRID.gt };
    const block: Block = { width: g.width, height: 1, bytes: g.width };
    const reads: { x0: number; y0: number; width: number; height: number }[] = [];
    const read = rowBandReader(g, block, async (w) => { reads.push({ ...w }); return new Uint8Array(w.width * w.height).fill(w.y0 % 251); });
    const out = await read({ x0: 69_888, y0: 256, width: 112, height: 44 });
    expect(out[0]).toBe(256 % 251);
    for (const w of reads) expect(decodedBytes(w, block, g.width, g.height)).toBeLessThanOrEqual(MAX_READ_BYTES);
  });
});

describe("imagery from the mask cache (criterion 4)", () => {
  it("makes no readWindow call, and leaves the masks it read in the cache it was given", async () => {
    const { source } = samplesSource({ ...GRID, bandCount: 2, nodata: 0, float: false, alpha: null }, (k, c, r) => (hash(c, r, k) % 7 === 0 ? 0 : 3), { width: 1000, height: 1, bytes: 2000 });
    const cache = new MaskCache(source);
    const r = await importLabels(source, fakeLabelSource(GRID, fileValue).source, null, undefined, undefined, cache);
    expect(typeof r).not.toBe("string");
    for (const w of seedWindows(GRID, GRID)) expect(cache.get(`${w.x0},${w.y0}`), `${w.x0},${w.y0}`).toBeDefined();
  });

  it("on tiled imagery, decodes only the tiles of windows the label file covers", async () => {
    const { source, reads } = samplesSource({ ...GRID, bandCount: 4, nodata: null, float: false, alpha: 3 }, (k, c) => (k === 3 ? (c > 600 ? 0 : 255) : 9), { width: 256, height: 256, bytes: 256 * 256 * 4 });
    const fgrid = at(300, 300, 150, 100); // inside windows 256,256 and 256,256+... only
    const file = fakeLabelSource(fgrid, () => 1).source;
    const covered = new Set(seedWindows(GRID, fgrid).filter((w) => sourceCells(GRID, fgrid, w).some((v) => v >= 0)).map((w) => `${w.x0},${w.y0}`));
    const r = await importLabels(source, file, null);
    expect(typeof r).not.toBe("string");
    expect(reads.length).toBeGreaterThan(0);
    for (const t of reads) for (let x = t.x0; x < t.x0 + t.width; x += 256) for (let y = t.y0; y < t.y0 + t.height; y += 256) {
      expect(covered.has(`${x - (x % 256)},${y - (y % 256)}`), `tile ${x},${y}`).toBe(true);
    }
  });
});

describe("review fixes", () => {
  it("a table of 256 classes gives \"too many\" before any file read or mask need", async () => {
    const { source } = samplesSource({ ...GRID, bandCount: 1, nodata: 0, float: false, alpha: null }, () => 3, { width: 1000, height: 1, bytes: 1000 });
    const cache = new MaskCache(source);
    let needs = 0;
    const need = cache.need.bind(cache);
    cache.need = (...a) => { needs++; return need(...a); };
    const f = fakeLabelSource(GRID, fileValue);
    const table = Array.from({ length: 256 }, (_, v) => ({ value: v, name: `c${v}` }));
    expect(await importLabels(source, f.source, table, undefined, undefined, cache)).toBe("too many");
    expect([f.reads.length, needs]).toEqual([0, 0]);
  });

  /** Runs an import on 1-row strips with performance.now advancing `step` ms a call; a task posted at window k cancels it. */
  async function clocked(step: number, k: number) {
    let t = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (t += step));
    try {
      const { source } = samplesSource({ ...GRID, bandCount: 1, nodata: 0, float: false, alpha: null }, () => 3, { width: 1000, height: 1, bytes: 1000 });
      const f = fakeLabelSource(GRID, fileValue);
      let cancelled = false;
      const r = await importLabels(source, f.source, null, () => cancelled, (done) => { if (done === k) void yieldToBrowser().then(() => { cancelled = true; }); });
      return { r, reads: f.reads };
    } finally { spy.mockRestore(); }
  }

  it("yields once 8 ms of work have passed, within a row, and checks stale there (fake clock)", async () => {
    // 10 ms a call: past the budget after every window, so the task posted at window 1 runs before window 2 is read
    const { r, reads } = await clocked(10, 1);
    expect(r).toBe("stale");
    expect(reads.map((w) => `${w.x0},${w.y0}`)).toEqual(["0,0"]);
    // a frozen clock never reaches the budget: no yield, so the same task never gets a turn and the import ends
    const still = await clocked(0, 1);
    expect(typeof still.r).toBe("object");
  });
});
