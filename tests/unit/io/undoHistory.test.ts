import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { footprint } from "../../../src/core/pixel";
import { TILE_SIZE } from "../../../src/core/types";
import { UNDO_BYTES, editBytes } from "../../../src/core/undo";
import { cellOp, PaintQueue } from "../../../src/io/paintQueue";
import type { RasterSource } from "../../../src/io/source";
import { UndoHistory } from "../../../src/io/undoHistory";
import { idle } from "../helpers/paintQueue";
import { fakeSource } from "../helpers/sources";

const MiB = 1024 * 1024;
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));

/** A held-able 4096x4096 source (16x16 tiles), all valid. */
function gated() {
  const { source: inner } = fakeSource({ width: 4096, height: 4096, nodata: -1 }, () => 5);
  let gate: Promise<void> | null = null, open = () => {};
  const source: RasterSource = {
    meta: inner.meta,
    async readWindow(x0, y0, w, h) { while (gate) await gate; return inner.readWindow(x0, y0, w, h); },
  };
  return { source, hold() { gate = new Promise((r) => { open = () => { gate = null; r(); }; }); }, release: () => open() };
}

function setup() {
  const src = gated();
  let store = emptyStore(4096, 4096);
  const history = new UndoHistory(() => store);
  const q = new PaintQueue(src.source, () => store, { applied: () => {}, busy: () => {}, error: (e) => { throw e; } }, history);
  return { src, q, history, store: () => store, reset: () => { store = emptyStore(4096, 4096); } };
}

/** One stroke of 1x1 cells at the given pixels, ended. */
function strokeAt(t: ReturnType<typeof setup>, cells: [number, number][], value: number, erase = false) {
  const s = t.history.begin();
  for (const [c, r] of cells) t.q.push(cellOp(footprint(t.store(), c, r, 1)!, value, erase, s));
  t.history.end(s);
}

describe("UndoHistory with the paint queue (spec 010 What an edit is / Undo)", () => {
  it("records a stroke whose cells wait for masks as one entry once they apply", async () => {
    const t = setup();
    t.src.hold();
    const before = snapshot(t.store());
    strokeAt(t, [[10, 10], [300, 10], [600, 600]], 1);
    expect(t.history.size).toBe(0); // the cells are still waiting
    t.src.release();
    await idle(t.q);
    expect(t.history.size).toBe(1);
    expect(t.store().tiles.size).toBe(3);
    expect(t.history.undo()).toEqual({ tiles: ["0,0", "256,0", "512,512"], boxes: [] });
    expect(snapshot(t.store())).toEqual(before);
    expect(t.history.size).toBe(0);
    expect(t.history.undo()).toBeNull();
  });

  it("appends nothing for a stroke that changes nothing, and finishes a stroke ended after its cells applied", async () => {
    const t = setup();
    strokeAt(t, [[10, 10]], 1, true); // erasing an absent class
    await idle(t.q);
    expect(t.history.size).toBe(0);
    const s = t.history.begin();
    t.q.push(cellOp(footprint(t.store(), 5, 5, 1)!, 1, false, s));
    await idle(t.q);
    expect(t.history.size).toBe(0); // still in progress
    t.history.end(s);
    expect(t.history.size).toBe(1);
  });

  it("clear() drops every entry and every unfinished stroke", async () => {
    const t = setup();
    strokeAt(t, [[10, 10]], 1);
    await idle(t.q);
    const s = t.history.begin();
    t.history.clear();
    t.history.end(s);
    expect(t.history.size).toBe(0);
  });

  it("memory (criterion 6): a 256-tile stroke over 24 one-MiB edits keeps the newest 16 and itself whole", async () => {
    const t = setup();
    // every tile stored
    const all = tileWindows(4096, 4096);
    expect(all).toHaveLength(256);
    strokeAt(t, all.map((w) => [w.x0, w.y0]), 1);
    await idle(t.q);
    t.history.clear();
    expect(t.store().tiles.size).toBe(256);
    // 24 one-MiB edits: each changes 16 tiles (one tile row)
    const rows = (k: number) => all.filter((w) => w.y0 === (k % 16) * TILE_SIZE);
    for (let k = 0; k < 24; k++) {
      strokeAt(t, rows(k).map((w) => [w.x0 + 1 + Math.floor(k / 16), w.y0]), 2);
      await idle(t.q);
    }
    expect(t.history.size).toBe(24);
    expect(t.history.entries().every((e) => editBytes(e.tiles) === MiB)).toBe(true);
    const oldest16 = t.history.entries().slice(8);
    // the big stroke, checking the budget after every cell
    const s = t.history.begin();
    let peak = 0;
    for (const w of all) {
      t.q.push(cellOp(footprint(t.store(), w.x0 + 7, w.y0 + 7, 1)!, 3, false, s));
      await idle(t.q);
      peak = Math.max(peak, t.history.bytes());
    }
    t.history.end(s);
    expect(peak).toBeLessThanOrEqual(UNDO_BYTES);
    expect(t.history.bytes()).toBeLessThanOrEqual(UNDO_BYTES);
    const e = t.history.entries();
    expect(e).toHaveLength(17);
    e.slice(0, 16).forEach((x, i) => expect(x).toBe(oldest16[i]));
    expect(e[16]!.tiles.size).toBe(256);
    expect(editBytes(e[16]!.tiles)).toBe(16 * MiB);
  });
});
