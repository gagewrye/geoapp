import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { footprint } from "../../../src/core/pixel";
import { TILE_SIZE } from "../../../src/core/types";
import { UNDO_BYTES } from "../../../src/core/undo";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import { UndoHistory } from "../../../src/io/undoHistory";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

// Spec 037 criteria 2-4.
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));

function setup() {
  const { source } = fakeSource({ width: 4096, height: 4096, nodata: -1 }, () => 5);
  const store = emptyStore(4096, 4096);
  const history = new UndoHistory(() => store);
  const q = new PaintQueue(source, () => store, { applied: () => {}, full: () => {}, busy: () => {}, error: (e) => { throw e; } }, history);
  /** One ended stroke of 1x1 cells. */
  const stroke = async (cells: [number, number][], value: number, erase = false) => {
    const s = history.begin();
    for (const [c, r] of cells) q.push(cellOp(footprint(store, c, r, 1)!, value, erase, s));
    history.end(s);
    await idle(q);
  };
  return { store, history, q, stroke };
}

describe("UndoHistory redo", () => {
  it("A, B, undo, undo, redo gives the store after A; a second redo gives it after B; a third returns null (criterion 2)", async () => {
    const t = setup();
    await t.stroke([[10, 10], [300, 10]], 1);
    const afterA = snapshot(t.store);
    await t.stroke([[300, 10], [600, 600]], 2);
    const afterB = snapshot(t.store);
    expect(t.history.redoSize).toBe(0);
    expect(t.history.redo()).toBeNull();
    t.history.undo();
    t.history.undo();
    expect(t.store.tiles.size).toBe(0);
    expect(t.history.redoSize).toBe(2);
    expect(t.history.redo()).toEqual(["0,0", "256,0"]);
    expect(snapshot(t.store)).toEqual(afterA);
    expect(t.history.size).toBe(1);
    expect(t.history.redo()).toEqual(["256,0", "512,512"]);
    expect(snapshot(t.store)).toEqual(afterB);
    expect(t.history.redo()).toBeNull();
    expect([t.history.size, t.history.redoSize]).toEqual([2, 0]);
    t.history.undo(); // redone strokes undo again
    expect(snapshot(t.store)).toEqual(afterA);
  });

  it("after an undo, a stroke that changes a tile empties the redo stack; one that changes none doesn't (criterion 3)", async () => {
    const t = setup();
    await t.stroke([[10, 10]], 1);
    await t.stroke([[20, 20]], 1);
    t.history.undo();
    expect(t.history.redoSize).toBe(1);
    await t.stroke([[30, 30]], 2, true); // erasing an absent class changes nothing
    expect(t.history.redoSize).toBe(1);
    await t.stroke([[40, 40]], 2);
    expect(t.history.redoSize).toBe(0);
    expect(t.history.redo()).toBeNull();
  });

  it("clear() empties the redo stack", async () => {
    const t = setup();
    await t.stroke([[10, 10]], 1);
    t.history.undo();
    t.history.clear();
    expect(t.history.redoSize).toBe(0);
    expect(t.history.redo()).toBeNull();
  });

  it("budget (criterion 4): after an undo, a large stroke stays within UNDO_BYTES and drops redo entries before history ones", async () => {
    const t = setup();
    const all = tileWindows(4096, 4096);
    await t.stroke(all.map((w) => [w.x0, w.y0]), 1); // every tile stored
    t.history.clear();
    // 24 one-MiB edits (one tile row each), then 4 undone: 20 in the history and 4 MiB on the redo stack
    const row = (k: number) => all.filter((w) => w.y0 === (k % 16) * TILE_SIZE);
    for (let k = 0; k < 24; k++) await t.stroke(row(k).map((w) => [w.x0 + 1 + Math.floor(k / 16), w.y0]), 2);
    for (let k = 0; k < 4; k++) t.history.undo();
    expect([t.history.size, t.history.redoSize]).toEqual([20, 4]);
    const MiB = 1024 * 1024;
    expect(t.history.bytes()).toBe(24 * MiB);
    // a 16 MiB stroke, checked after every cell
    const s = t.history.begin();
    let peak = 0, redoLeftWhenHistoryShrank = -1;
    for (const w of all) {
      t.q.push(cellOp(footprint(t.store, w.x0 + 7, w.y0 + 7, 1)!, 3, false, s));
      await idle(t.q);
      peak = Math.max(peak, t.history.bytes());
      if (redoLeftWhenHistoryShrank < 0 && t.history.size < 20) redoLeftWhenHistoryShrank = t.history.redoSize;
    }
    expect(t.history.redoSize).toBe(0); // dropped to make room before the stroke settled
    t.history.end(s);
    expect(redoLeftWhenHistoryShrank).toBe(0);
    expect(peak).toBeLessThanOrEqual(UNDO_BYTES);
    expect(t.history.bytes()).toBeLessThanOrEqual(UNDO_BYTES);
    expect(t.history.size).toBe(17);
  });
});
