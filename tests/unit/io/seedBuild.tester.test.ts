import { describe, expect, it } from "vitest";
import { initialClasses, type LabelClass } from "../../../src/core/classes";
import type { ClassEntry } from "../../../src/core/classTable";
import { tileWindows, type Window } from "../../../src/core/grid";
import { emptyStore, MAX_LABEL_TILES, type LabelStore } from "../../../src/core/labelStore";
import type { Affine, Grid } from "../../../src/core/types";
import type { LabelSource } from "../../../src/io/labelFile";
import { importLabels, type Labels, type SeedOutcome } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { fakeLabelSource } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Tester checks of spec 004's Merge or Replace build and its memory rule: the current labels are
// never written (success, "too many", "empty", "stale"), imports no longer reach the cap (spec 014),
// the N and K counts, and, structurally, that every read is one aligned window of at most 256x256
// with one read in flight, that a stale run stops reading, and that huge rasters are never read whole.

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

  for (const mode of ["merge", "replace"] as const) {
    it(`${mode}: success, "too many", "empty" and "stale" leave the current store, its tile arrays and the list unchanged`, { timeout: 30_000 }, async () => {
      const cur = labelsWith(5, 1024);
      const s = snapshot(cur);
      const r = ok(await importLabels(imagery(), file(), table, cur, mode));
      expectUntouched(cur, s);
      expect(r.store).not.toBe(cur.store);
      expect(r.store.tiles).not.toBe(cur.store.tiles);
      const many = { ...cur, classes: Array.from({ length: 255 }, (_, i) => ({ name: `c${i}`, colour: "#000000" })) };
      const sm = snapshot(many);
      // Replace starts from no classes, so only Merge can pass 255
      if (mode === "merge") expect(await importLabels(imagery(), file(), table, many, mode)).toBe("too many");
      else expect(typeof (await importLabels(imagery(), file(), table, many, mode))).toBe("object");
      expectUntouched(many, sm);
      expect(await importLabels(imagery(), file(), [{ value: 9, name: "absent" }], cur, mode)).toBe("empty");
      expectUntouched(cur, s);
      let calls = 0;
      expect(await importLabels(imagery(), file(), table, cur, mode, () => ++calls > 3)).toBe("stale");
      expectUntouched(cur, s);
    });
  }

  it("a Merge result shares only tiles it didn't seed; every seeded tile is a new array", { timeout: 30_000 }, async () => {
    const cur = labelsWith(16, 1024);
    // the file labels only the top-left 512 x 512, i.e. tiles 0,0 256,0 0,256 256,256
    const r = ok(await importLabels(imagery(), file((c, rr) => (c < 512 && rr < 512 ? 3 : 0)), table, cur, "merge"));
    for (const [k, t] of r.store.tiles) {
      const seeded = ["0,0", "256,0", "0,256", "256,256"].includes(k);
      if (seeded) expect(t, k).not.toBe(cur.store.tiles.get(k)); else expect(t, k).toBe(cur.store.tiles.get(k));
    }
  });
});

describe("Merge and Replace never reach the cap (spec 014: the file is a base)", () => {
  const size = 256 * 17; // 289 tiles
  const g: Grid = { width: size, height: size, epsg: 32633, gt: GT };
  const imagery = () => fakeSource({ ...g, bandCount: 1 }, () => 1).source;
  const table: ClassEntry[] = [{ value: 3, name: "three" }];
  /** File labelling only the given tile windows. */
  const fileOn = (ws: Window[]) => {
    const on = new Uint8Array(17 * 17);
    for (const w of ws) on[(w.y0 >> 8) * 17 + (w.x0 >> 8)] = 1;
    return fakeLabelSource(g, (c, r) => (on[(r >> 8) * 17 + (c >> 8)] ? 3 : 0)).source;
  };
  const all = tileWindows(size, size);

  it("Merge with 256 stored tiles merges those and stores no new tile, however many the file labels", { timeout: 120_000 }, async () => {
    const cur = labelsWith(MAX_LABEL_TILES, size);
    const r = ok(await importLabels(imagery(), fileOn(all.slice(250, 289)), table, cur, "merge"));
    expect([...r.store.tiles.keys()]).toEqual([...cur.store.tiles.keys()]);
    expect(r.pixels).toBe(6 * (65536 - 1) + 33 * 65536); // painted first pixels win
  });

  it("Replace with 256 stored tiles stores none, with all 289 tiles labelled", { timeout: 120_000 }, async () => {
    const cur = labelsWith(MAX_LABEL_TILES, size);
    const r = ok(await importLabels(imagery(), fileOn(all), table, cur, "replace"));
    expect(r.store.tiles.size).toBe(0);
    expect(r.base.count).toBe(size * size);
    expect(r.classes).toEqual([{ name: "three", colour: expect.any(String) }]);
  });
});

describe("N and K", () => {
  it("count only newly labelled pixels and their classes: a class seeded only under painted pixels isn't counted", async () => {
    const g: Grid = { width: 256, height: 256, epsg: 32633, gt: GT };
    const cur = labelsWith(0, 256);
    const t = new Uint8Array(65536); t.fill(2, 0, 256); // row 0 painted Class 2
    cur.store.tiles.set("0,0", t);
    // file: row 0 is 8, everything else 5
    const { source } = fakeSource({ ...g, bandCount: 1 }, () => 1);
    const r = ok(await importLabels(source, fakeLabelSource(g, (_c, r) => (r === 0 ? 8 : 5)).source, [{ value: 5, name: "five" }, { value: 8, name: "eight" }], cur, "merge"));
    expect(r.pixels).toBe(65536 - 256);
    expect(r.classCount).toBe(1);
    expect(r.classes.map((c) => c.name)).toEqual(["Class 1", "Class 2", "five", "eight"]);
    expect(r.store.tiles.get("0,0")!.subarray(0, 256).every((v) => v === 2)).toBe(true);
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
    ok(await importLabels(io.imagery, io.file, null, { store: emptyStore(65536, 65536), classes: initialClasses() }, "replace"));
    expect(io.max()).toBe(1);
    expect(io.log.every((e) => aligned(e.w))).toBe(true);
    const imageryReads = io.log.filter((e) => e.kind === "i");
    expect(new Set(imageryReads.map((e) => `${e.w.x0},${e.w.y0}`)).size).toBe(imageryReads.length);
    expect(imageryReads.length).toBeLessThan(60); // the file covers about 11 x 10 km, i.e. about 5 x 5 windows
    expect(io.log.filter((e) => e.kind === "f").length).toBeLessThan(400);
  });

  it("a 200000 x 200000 file under a small imagery reads only the file windows holding its cells", { timeout: 60_000 }, async () => {
    const img: Grid = { width: 600, height: 500, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
    const f: Grid = { width: 200000, height: 200000, epsg: 32633, gt: [0, 5, 0, 5500000, 0, -5] };
    const io = instrument(fakeSource({ ...img, bandCount: 1 }, () => 1).source, fakeLabelSource(f, () => 2).source);
    ok(await importLabels(io.imagery, io.file, [{ value: 2, name: "two" }], { store: emptyStore(600, 500), classes: initialClasses() }, "replace"));
    expect(io.max()).toBe(1);
    expect(io.log.every((e) => aligned(e.w))).toBe(true);
    // the imagery covers 18 x 15 km = 3600 x 3000 file px: at most 16 x 13 file windows, each read once per imagery window
    const fileReads = io.log.filter((e) => e.kind === "f");
    expect(new Set(fileReads.map((e) => `${e.w.x0},${e.w.y0}`)).size).toBeLessThanOrEqual(16 * 13);
    expect(fileReads.length).toBeLessThanOrEqual(16 * 13 + 6 * 16 + 6 * 13); // window seams read twice at most
    expect(io.log.filter((e) => e.kind === "i")).toHaveLength(tileWindows(600, 500).length);
  });

  it("a stale run reads nothing more once stale", { timeout: 30_000 }, async () => {
    const g: Grid = { width: 2048, height: 2048, epsg: 32633, gt: GT };
    const io = instrument(fakeSource({ ...g, bandCount: 1 }, () => 1).source, fakeLabelSource(g, () => 4).source);
    // stale from the 5th read on (a raster opened meanwhile); on equal grids each imagery window needs one file window
    expect(await importLabels(io.imagery, io.file, null, { store: emptyStore(2048, 2048), classes: initialClasses() }, "replace", () => io.log.length >= 5)).toBe("stale");
    expect(io.log).toHaveLength(5);
    const later = instrument(fakeSource({ ...g, bandCount: 1 }, () => 1).source, fakeLabelSource(g, () => 4).source);
    // in the labelling pass: file read 64 + 3 is the third window's, so its imagery read never starts
    expect(await importLabels(later.imagery, later.file, null, { store: emptyStore(2048, 2048), classes: initialClasses() }, "replace", () => later.log.length >= 64 + 5)).toBe("stale");
    expect(later.log.slice(64).map((e) => e.kind)).toEqual(["f", "i", "f", "i", "f"]);
  });
});

export type { LabelStore };
