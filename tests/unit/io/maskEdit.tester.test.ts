import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import type { LabelStore } from "../../../src/core/labelStore";
import { footprint } from "../../../src/core/pixel";
import type { Affine, Grid } from "../../../src/core/types";
import { maskReadFailed } from "../../../src/io/labelFile";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import { importLabels } from "../../../src/io/seeding";
import { UndoHistory } from "../../../src/io/undoHistory";
import { effectiveTiles } from "../helpers/effective";
import { fakeLabelSource } from "../helpers/labelFiles";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

// Tester edges of spec 014: undo across copy on touch, the mask file failing mid-stroke, read counts of
// copy on touch, and the mask base holding nothing per raster pixel (CLAUDE.md: never a full raster).
const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
const maskValue = (c: number, r: number) => ((c + r) % 2 ? 6 : 4);
const TABLE = [{ value: 4, name: "four" }, { value: 6, name: "six" }];

async function setup(width = 1024, height = width) {
  const grid: Grid = { width, height, epsg: 32633, gt };
  const imagery = fakeSource({ ...grid, bandCount: 1 }, () => 1);
  const file = fakeLabelSource(grid, maskValue);
  const r = await importLabels(imagery.source, file.source, TABLE);
  if (typeof r === "string") throw new Error(r);
  const store: LabelStore = r.store;
  const history = new UndoHistory(() => store);
  const errors: unknown[] = [];
  const q = new PaintQueue(imagery.source, () => store, { applied: () => {}, full: () => {}, busy: () => {}, error: (e) => { errors.push(e); } },
    history, () => r.base);
  const strokeAt = async (cells: [number, number][], value: number, erase = false, side = 1) => {
    const s = history.begin();
    for (const [c, rr] of cells) q.push(cellOp(footprint(store, c, rr, side)!, value, erase, s));
    history.end(s);
    await idle(q);
  };
  imagery.reads.length = 0;
  file.reads.length = 0;
  return { imagery, file, r, store, history, q, errors, strokeAt };
}
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));
const same = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) =>
  a.size === b.size && [...a].every(([k, t]) => b.has(k) && Buffer.from(t).equals(Buffer.from(b.get(k)!)));

describe("undo across copy on touch (spec 014, ADR 0018: a null entry shows the mask again)", () => {
  it("stroke A copies a base tile, stroke B edits the copy: Undo B restores A's tile, Undo A shows the mask", { timeout: 60_000 }, async () => {
    const t = await setup();
    const imported = await effectiveTiles(t.imagery.source, { store: t.store, base: t.r.base });
    await t.strokeAt([[10, 10]], 2, false, 3);
    const afterA = snapshot(t.store);
    expect([...afterA.keys()]).toEqual(["0,0"]);
    await t.strokeAt([[20, 20], [300, 20]], 1, false, 3);
    expect([...t.store.tiles.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(t.history.undo()).toEqual(["0,0", "256,0"]);
    expect(same(t.store.tiles, afterA)).toBe(true);
    expect(t.history.undo()).toEqual(["0,0"]);
    expect(t.store.tiles.size).toBe(0);
    expect(same(await effectiveTiles(t.imagery.source, { store: t.store, base: t.r.base }), imported)).toBe(true);
  });

  it("a paint that leaves every pixel at its base value still copies the tile (copy on touch) as one undo step; Undo deletes it", { timeout: 60_000 }, async () => {
    const t = await setup();
    const imported = await effectiveTiles(t.imagery.source, { store: t.store, base: t.r.base });
    await t.strokeAt([[10, 10]], 1); // (10 + 10) even: base label 1 already
    expect([...t.store.tiles.keys()]).toEqual(["0,0"]);
    expect(same(await effectiveTiles(t.imagery.source, { store: t.store, base: t.r.base }), imported)).toBe(true);
    expect(t.history.size).toBe(1);
    t.history.undo();
    expect(t.store.tiles.size).toBe(0);
  });
});

describe("the mask file failing mid-stroke (criterion 12, tester)", () => {
  it("cells before the failure stay and are one undo step; the rest of the stroke changes nothing; stored tiles still paint", { timeout: 60_000 }, async () => {
    const t = await setup();
    const read = t.r.base.file.read.bind(t.r.base.file);
    let n = 0;
    t.r.base.file.read = async (w) => { if (n++ >= 1) throw new DOMException("gone", "NotFoundError"); return read(w); };
    await t.strokeAt([[10, 10], [300, 10], [600, 10]], 2);
    expect(t.errors).toHaveLength(1);
    expect(maskReadFailed(t.errors[0])).toBe(true);
    expect([...t.store.tiles.keys()]).toEqual(["0,0"]);
    expect(t.history.size).toBe(1);
    // a cell on the stored tile needs no mask-file read, so it still applies
    await t.strokeAt([[11, 11]], 2);
    expect(t.errors).toHaveLength(1);
    expect(t.store.tiles.get("0,0")![11 * 256 + 11]).toBe(2);
    t.history.undo();
    t.history.undo();
    expect(t.store.tiles.size).toBe(0);
  });
});

describe("copy-on-touch reads (tester)", () => {
  it("a stroke over 16 base tiles reads each imagery band once (spec 023: the cached mask serves copy-on-touch) and each file window once", { timeout: 60_000 }, async () => {
    const t = await setup();
    const cells: [number, number][] = [];
    for (let c = 5; c < 1024; c += 37) cells.push([c, c]);
    for (let c = 5; c < 1024; c += 61) cells.push([c, 1018 - c]);
    await t.strokeAt(cells, 2);
    const keys = (rs: { x0: number; y0: number; width: number; height: number }[]) => rs.map((w) => `${w.x0},${w.y0},${w.width},${w.height}`);
    const im = keys(t.imagery.reads), fi = keys(t.file.reads);
    expect(new Set(im).size).toBe(im.length);
    expect(new Set(fi).size).toBe(fi.length);
    expect(im.length).toBe(4); // the 4 bands of 1024 rows
    for (const w of t.imagery.reads) expect([w.x0, w.y0 % 256, w.width, w.height]).toEqual([0, 0, 1024, 256]);
    for (const w of t.file.reads) {
      expect(w.x0 % 256 + w.y0 % 256).toBe(0);
      expect(Math.max(w.width, w.height)).toBeLessThanOrEqual(256);
    }
    // a second stroke over the same tiles reads no file window
    const before = t.file.reads.length;
    await t.strokeAt(cells.map(([c, r]) => [c + 1, r]), 1);
    expect(t.file.reads.length).toBe(before);
  });
});

describe("the mask base holds nothing per raster pixel (CLAUDE.md, ADR 0018)", () => {
  it("on a 6144 x 2048 mask: preview arrays are at most 1024 px across, windows one key per tile, no tile stored", { timeout: 120_000 }, async () => {
    const t = await setup(6144, 2048);
    const { preview, windows } = t.r.base;
    expect(Math.max(preview.width, preview.height)).toBe(1024);
    expect(preview.values.length).toBe(preview.width * preview.height);
    expect(preview.buckets.order.length).toBeLessThanOrEqual(preview.width * preview.height);
    expect(preview.buckets.start.length).toBe(tileWindows(6144, 2048).length + 1);
    expect(windows.size).toBeLessThanOrEqual(tileWindows(6144, 2048).length);
    expect(t.store.tiles.size).toBe(0);
    // every typed array the base holds is bounded by the preview, never by the raster's 12.6 M pixels
    const arrays = [preview.values, preview.buckets.order, preview.buckets.start, t.r.base.lut];
    for (const a of arrays) expect(a.length).toBeLessThanOrEqual(1024 * 1024);
  });
});
