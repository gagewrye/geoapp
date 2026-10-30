import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { footprint } from "../../../src/core/pixel";
import { TILE_SIZE } from "../../../src/core/types";
import { UNDO_BYTES, UNDO_STEPS, editBytes } from "../../../src/core/undo";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import type { RasterSource } from "../../../src/io/source";
import { UndoHistory } from "../../../src/io/undoHistory";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

// Tester edge cases for spec 010 "What an edit is", Undo and Clearing, through the paint queue.
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));

function setup(opts: { fail?: (x0: number, y0: number) => boolean; w?: number; h?: number } = {}) {
  const W = opts.w ?? 4096, H = opts.h ?? 4096;
  const { source: inner, reads } = fakeSource({ width: W, height: H, nodata: -1 }, () => 5);
  let gate: Promise<void> | null = null, open = () => {};
  const source: RasterSource = {
    meta: inner.meta,
    async readWindow(x0, y0, w, h) {
      while (gate) await gate;
      if (opts.fail?.(x0, y0)) throw new Error("read failed");
      return inner.readWindow(x0, y0, w, h);
    },
  };
  const store = emptyStore(W, H);
  const history = new UndoHistory(() => store);
  const errors: unknown[] = [];
  const q = new PaintQueue(source, () => store, { applied: () => {}, full: () => {}, busy: () => {}, error: (e) => errors.push(e) }, history);
  return { q, history, store, reads, errors, hold() { gate = new Promise((r) => { open = () => { gate = null; r(); }; }); }, release: () => open() };
}
type T = ReturnType<typeof setup>;
const cells = (t: T, s: ReturnType<UndoHistory["begin"]>, pts: [number, number][], value: number, side = 1, erase = false) => {
  for (const [c, r] of pts) t.q.push(cellOp(footprint(t.store, c, r, side)!, value, erase, s));
};

describe("UndoHistory edges (spec 010, tester)", () => {
  it("a failed read mid-stroke keeps what applied undoable, as one entry", async () => {
    const t = setup({ fail: (_x0, y0) => y0 === 256 }); // spec 023: masks are read by 256-row band
    const s = t.history.begin();
    cells(t, s, [[10, 10], [300, 10], [600, 300], [700, 300]], 1);
    await idle(t.q);
    t.history.end(s);
    expect(t.errors).toHaveLength(1);
    expect([...t.store.tiles.keys()].sort()).toEqual(["0,0", "256,0"]);
    expect(t.history.size).toBe(1);
    expect(t.history.undo()).toEqual(["0,0", "256,0"]);
    expect(t.store.tiles.size).toBe(0);
  });

  it("a second stroke started while the first's cells wait: entries stay in stroke order and each undo reverts one", async () => {
    const t = setup();
    t.hold();
    const a = t.history.begin();
    cells(t, a, [[10, 10], [20, 10]], 1, 3);
    t.history.end(a);
    const b = t.history.begin();
    cells(t, b, [[20, 10], [300, 10]], 2, 3);
    t.history.end(b);
    expect(t.history.size).toBe(0);
    t.release();
    await idle(t.q);
    expect(t.history.size).toBe(2);
    const afterA = setup(); // reference store holding A only
    const ra = afterA.history.begin();
    cells(afterA, ra, [[10, 10], [20, 10]], 1, 3);
    afterA.history.end(ra);
    await idle(afterA.q);
    expect(t.history.undo()).toEqual(["0,0", "256,0"]);
    expect(snapshot(t.store)).toEqual(snapshot(afterA.store));
    expect(t.history.undo()).toEqual(["0,0"]);
    expect(t.store.tiles.size).toBe(0);
  });

  it("clearing (raster open) while cells are queued leaves no history, even after they would apply", async () => {
    const t = setup();
    t.hold();
    const s = t.history.begin();
    cells(t, s, [[10, 10]], 1);
    t.history.end(s);
    t.q.clear();
    t.history.clear();
    t.release();
    await idle(t.q);
    expect(t.history.size).toBe(0);
    expect(t.history.bytes()).toBe(0);
  });

  it("cells pushed without a stroke (the e2e hook) bypass the history", async () => {
    const t = setup();
    t.q.push(cellOp(footprint(t.store, 5, 5, 1)!, 1, false));
    await idle(t.q);
    expect(t.history.size).toBe(0);
    expect(t.store.tiles.size).toBe(1);
  });

  it("an erase stroke reads nothing and is undoable", async () => {
    const t = setup();
    const a = t.history.begin();
    cells(t, a, [[10, 10]], 1, 7);
    t.history.end(a);
    await idle(t.q);
    const before = snapshot(t.store), nReads = t.reads.length;
    const b = t.history.begin();
    cells(t, b, [[10, 10]], 1, 3, true);
    t.history.end(b);
    await idle(t.q);
    expect(t.reads.length).toBe(nReads);
    t.history.undo();
    expect(snapshot(t.store)).toEqual(before);
  });

  it("51 small strokes keep 50; bytes never exceed UNDO_BYTES over 40 strokes of 64 tiles each (structural, after every cell)", async () => {
    const t = setup();
    for (let k = 0; k < 51; k++) {
      const s = t.history.begin();
      cells(t, s, [[k, 0]], 1 + (k % 2));
      t.history.end(s);
      await idle(t.q);
    }
    expect(t.history.size).toBe(UNDO_STEPS);
    t.history.clear();
    const all = tileWindows(4096, 4096);
    let peak = 0;
    for (let k = 0; k < 40; k++) {
      const s = t.history.begin();
      for (const w of all.slice((k % 4) * 64, (k % 4) * 64 + 64)) {
        t.q.push(cellOp(footprint(t.store, w.x0 + (k % 200), w.y0 + 3, 1)!, 1 + (k % 3), false, s));
        await idle(t.q);
        peak = Math.max(peak, t.history.bytes());
      }
      t.history.end(s);
      peak = Math.max(peak, t.history.bytes());
    }
    expect(peak).toBeLessThanOrEqual(UNDO_BYTES);
    // each 64-tile entry (once tiles exist) is 4 MiB, so 8 fit
    expect(t.history.entries().every((e) => editBytes(e) <= 64 * TILE_SIZE * TILE_SIZE)).toBe(true);
    expect(t.history.size).toBeLessThanOrEqual(UNDO_STEPS);
  }, 30_000); // 2,560 cells with 64 KiB tile copies: about 4 s alone, more under full-suite load
});
