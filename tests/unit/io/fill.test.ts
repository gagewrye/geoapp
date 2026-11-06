import { describe, expect, it } from "vitest";
import { FILL_REACH } from "../../../src/core/fill";
import type { Window } from "../../../src/core/grid";
import type { LabelStore } from "../../../src/core/labelStore";
import { spansBox, type Span } from "../../../src/core/spans";
import type { Affine, Grid } from "../../../src/core/types";
import { fillReader, floodFill, type FillRead, type FillResult } from "../../../src/io/fill";
import { PaintQueue } from "../../../src/io/paintQueue";
import { importLabels } from "../../../src/io/seeding";
import { UndoHistory } from "../../../src/io/undoHistory";
import { effectiveTiles } from "../helpers/effective";
import { fakeLabelSource } from "../helpers/labelFiles";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

// Spec 054 criteria 3 and 4.
type Px = (c: number, r: number) => number;
const cells = (spans: Span[]) => new Set(spans.flatMap((s) => Array.from({ length: s.x1 - s.x0 }, (_, i) => `${s.x0 + i},${s.row}`)));

/** A reader over label and validity functions, logging each window it reads. */
function reader(label: Px, valid: Px = () => 1) {
  const reads: Window[] = [];
  const read: FillRead = async (_key, t) => {
    reads.push(t);
    const labels = new Uint8Array(t.width * t.height), mask = new Uint8Array(Math.ceil(labels.length / 8));
    for (let i = 0; i < labels.length; i++) {
      const c = t.x0 + (i % t.width), r = t.y0 + Math.floor(i / t.width);
      labels[i] = label(c, r);
      if (!valid(c, r)) mask[i >> 3]! |= 1 << (i & 7);
    }
    return { labels, mask };
  };
  return { read, reads };
}

/** The whole-raster 4-connected fill, for reference. */
function reference(dims: { width: number; height: number }, [c0, r0]: [number, number], label: Px, valid: Px = () => 1): Set<string> {
  const target = label(c0, r0), out = new Set<string>([`${c0},${r0}`]), stack: [number, number][] = [[c0, r0]];
  while (stack.length) {
    const [c, r] = stack.pop()!;
    for (const [x, y] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]] as [number, number][]) {
      if (x < 0 || y < 0 || x >= dims.width || y >= dims.height || out.has(`${x},${y}`) || label(x, y) !== target || !valid(x, y)) continue;
      out.add(`${x},${y}`);
      stack.push([x, y]);
    }
  }
  return out;
}

const DIMS = { width: 700, height: 600 }; // 3 x 3 tiles, the last column and row partial
/** A ring of label 2 around (350, 300), a spiral-ish comb of 3s inside it, 1 elsewhere. */
const rings: Px = (c, r) => {
  const d = Math.hypot(c - 350, r - 300);
  if (d > 200 && d < 215) return 2;
  if (d < 200 && c % 40 < 6 && r > 150 + (Math.floor(c / 40) % 2) * 40 && r < 430 + (Math.floor(c / 40) % 2) * 40) return 3;
  return 1;
};

describe("floodFill", () => {
  it("equals a whole-raster flood fill for regions that cross tiles and partial edge tiles", async () => {
    for (const cell of [[350, 300], [5, 5], [556, 300], [699, 599], [362, 300]] as [number, number][]) {
      const { read } = reader(rings);
      const r = (await floodFill(DIMS, cell, 9, read)) as FillResult;
      const want = reference(DIMS, cell, rings);
      expect(cells(r.spans), String(cell)).toEqual(want);
      expect(r.pixels).toBe(want.size);
      expect(r.target).toBe(rings(...cell));
      expect(r.clipped).toBe(false);
    }
  });

  it("stops at nodata, and reads only the tiles the region reaches, one window each, none larger than a tile", async () => {
    // nodata along column 300 walls off the right; the region is tile column 0 and part of column 1
    const valid: Px = (c) => (c === 300 ? 0 : 1);
    const { read, reads } = reader(() => 0, valid);
    const r = (await floodFill(DIMS, [10, 10], 1, read)) as FillResult;
    expect(cells(r.spans)).toEqual(reference(DIMS, [10, 10], () => 0, valid));
    expect(reads.map((w) => `${w.x0},${w.y0}`).sort()).toEqual(["0,0", "0,256", "0,512", "256,0", "256,256", "256,512"]);
    for (const w of reads) expect(w.width <= 256 && w.height <= 256).toBe(true);
  });

  it("says nodata for a click with no imagery and same for a click already of the value, after one read", async () => {
    const a = reader(() => 0, (c) => (c < 100 ? 0 : 1));
    expect(await floodFill(DIMS, [50, 50], 1, a.read)).toBe("nodata");
    expect(a.reads).toHaveLength(1);
    const b = reader(() => 4);
    expect(await floodFill(DIMS, [50, 50], 4, b.read)).toBe("same");
    expect(b.reads).toHaveLength(1);
  });

  it("stops FILL_REACH tiles from the clicked tile, says it was clipped, and reads at most 81 tiles", async () => {
    const dims = { width: 256 * 14, height: 256 * 14 };
    const { read, reads } = reader(() => 0);
    const r = (await floodFill(dims, [256 * 7 + 3, 256 * 7 + 9], 1, read)) as FillResult;
    const side = 2 * FILL_REACH + 1;
    expect(reads).toHaveLength(side * side);
    expect(spansBox(r.spans)).toEqual({ x0: 256 * 3, y0: 256 * 3, width: 256 * side, height: 256 * side });
    expect(r.pixels).toBe((256 * side) ** 2);
    expect(r.clipped).toBe(true);
    // near a raster corner the reach is cut by the raster, which isn't a clip on that side
    const corner = reader(() => 0);
    const c = (await floodFill({ width: 600, height: 600 }, [10, 10], 1, corner.read)) as FillResult;
    expect(c.clipped).toBe(false);
    expect(c.pixels).toBe(600 * 600);
  });

  it("gives null once stop turns true, without further reads", async () => {
    const { read, reads } = reader(() => 0);
    let stop = false;
    const gated: FillRead = async (k, t) => { const tile = await read(k, t); if (reads.length === 3) stop = true; return tile; };
    expect(await floodFill(DIMS, [10, 10], 1, gated, () => stop)).toBeNull();
    expect(reads.length).toBeLessThan(9);
  });

  it("rejects when a read fails", async () => {
    await expect(floodFill(DIMS, [10, 10], 1, async () => { throw new Error("gone"); })).rejects.toThrow("gone");
  });
});

// The reader against the real store, mask base, mask cache and paint queue.
const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
const grid: Grid = { width: 600, height: 520, epsg: 32633, gt };
/** File value 4 (label 1) in a disc around (300, 260), else 6 (label 2); imagery nodata (0) left of column 40. */
const fileValue = (c: number, r: number) => (Math.hypot(c - 300, r - 260) < 180 ? 4 : 6);

async function withBase() {
  const imagery = fakeSource({ ...grid, bandCount: 1, nodata: 0, float: false }, (_b, c) => (c < 40 ? 0 : 1));
  const file = fakeLabelSource(grid, fileValue);
  const r = await importLabels(imagery.source, file.source, [{ value: 4, name: "four" }, { value: 6, name: "six" }, { value: 9, name: "nine" }]);
  if (typeof r === "string") throw new Error(r);
  const store: LabelStore = r.store, history = new UndoHistory(() => store);
  const q = new PaintQueue(imagery.source, () => store, { applied: () => {}, busy: () => {}, error: (e) => { throw e; } }, history, () => r.base);
  const label: Px = (c, rr) => (c < 40 ? 0 : fileValue(c, rr) === 4 ? 1 : 2);
  const fill = async (cell: [number, number], value: number) => {
    const res = await floodFill(store, cell, value, fillReader(imagery.source, store, r.base, q.cache));
    if (res && typeof res !== "string") {
      const s = history.begin();
      q.push({ spans: res.spans, box: spansBox(res.spans)!, value, erase: false, stroke: s });
      history.end(s);
      await idle(q);
    }
    return res;
  };
  /** Every pixel's effective label. */
  const labels = async () => {
    const tiles = await effectiveTiles(imagery.source, { store, base: r.base });
    return (c: number, rr: number) => { const x0 = Math.floor(c / 256) * 256, y0 = Math.floor(rr / 256) * 256; return tiles.get(`${x0},${y0}`)![(rr - y0) * Math.min(256, grid.width - x0) + (c - x0)]!; };
  };
  return { store, history, label, fill, labels };
}

describe("fillReader with a mask base", () => {
  it("fills a region of the unedited mask, then of edited tiles, and one undo restores each", async () => {
    const t = await withBase();
    expect(t.store.tiles.size).toBe(0);
    const res = (await t.fill([300, 260], 3)) as FillResult;
    const disc = reference(grid, [300, 260], t.label, (c) => (c < 40 ? 0 : 1));
    expect(cells(res.spans)).toEqual(disc);
    let at = await t.labels();
    for (let r = 0; r < grid.height; r += 7) for (let c = 0; c < grid.width; c += 7) expect(at(c, r), `${c},${r}`).toBe(disc.has(`${c},${r}`) ? 3 : t.label(c, r));
    // the surround (label 2), now partly in stored tiles and partly still in the base, stops at nodata and at the disc
    const around = (await t.fill([590, 10], 1)) as FillResult;
    expect(around.target).toBe(2);
    expect(around.pixels).toBe((grid.width - 40) * grid.height - disc.size);
    at = await t.labels();
    expect([at(10, 10), at(45, 10), at(300, 260)]).toEqual([0, 1, 3]);
    expect(t.history.size).toBe(2);
    t.history.undo();
    t.history.undo();
    expect(t.store.tiles.size).toBe(0);
    expect(await t.fill([10, 10], 1)).toBe("nodata");
  });
});
