import { describe, expect, it } from "vitest";
import { addBox, emptyBoxes, removeBox, setBox, type BoxStore, type Rect } from "../../../src/core/boxes";
import { emptyStore } from "../../../src/core/labelStore";
import { TILE_SIZE } from "../../../src/core/types";
import { BOX_BYTES, UNDO_BYTES, UNDO_STEPS } from "../../../src/core/undo";
import { UndoHistory } from "../../../src/io/undoHistory";

// Tester edge cases for spec 063 criteria 6 to 8: tile and box entries interleaved, trimming, redo and clear().
const TILE = TILE_SIZE * TILE_SIZE, MiB = 1024 * 1024;
const r: Rect = { x0: 1, y0: 2, x1: 5, y1: 9 };

function setup(width = 4096, height = 4096) {
  let store = emptyStore(width, height), boxes = emptyBoxes();
  const history = new UndoHistory(() => store, () => boxes);
  const boxStep = (ids: number[], f: (b: BoxStore) => void) => {
    const s = history.begin();
    history.recordBoxes(s, ids);
    f(boxes);
    history.end(s);
  };
  const stroke = (keys: string[], v: number) => {
    const s = history.begin();
    history.record(s, keys);
    for (const k of keys) store.tiles.set(k, new Uint8Array(TILE).fill(v));
    history.end(s);
  };
  const add = (rect = r, v = 1) => { let id = 0; boxStep([boxes.next], (b) => { id = addBox(b, rect, v).id; }); return id; };
  /** A new raster or a replaced store: what labels.open() and replace() do, in their order. */
  const reopen = (keepBoxes: boolean) => { history.clear(); store = emptyStore(width, height); if (!keepBoxes) boxes = emptyBoxes(); };
  return { get store() { return store; }, get boxes() { return boxes; }, history, boxStep, stroke, add, reopen };
}
const row = (y: number) => Array.from({ length: 16 }, (_, i) => `${i * 256},${y * 256}`); // 16 tiles = 1 MiB of copies

describe("byte trimming with box entries (tester)", () => {
  it("a box entry pushing a full history over UNDO_BYTES drops the oldest tile entry, not itself", () => {
    const t = setup();
    for (let k = 0; k < 16; k++) t.stroke(row(k), 1); // every tile exists
    t.history.clear();
    // 32 strokes of 1 MiB copies each: exactly UNDO_BYTES
    for (let k = 0; k < 32; k++) t.stroke(row(k % 16), 2 + k);
    expect(t.history.bytes()).toBe(UNDO_BYTES);
    const oldest = t.history.entries()[0]!, second = t.history.entries()[1]!;
    const id = t.add();
    expect(t.history.bytes()).toBe(UNDO_BYTES - MiB + BOX_BYTES);
    expect(t.history.entries()).not.toContain(oldest);
    expect(t.history.entries()[0]).toBe(second);
    expect(t.history.undo()).toEqual({ tiles: [], boxes: [id] });
  });

  it("box bytes are held while an edit is open, then by the entry", () => {
    const t = setup();
    const s = t.history.begin();
    t.history.recordBoxes(s, [1, 2, 3]);
    expect(t.history.bytes()).toBe(3 * BOX_BYTES);
    addBox(t.boxes, r, 1); // only id 1 changes
    t.history.end(s);
    expect(t.history.bytes()).toBe(BOX_BYTES);
  });

  it("an undo's inverse of an add holds the box (48 bytes), so bytes() stays the same across undo and redo", () => {
    const t = setup();
    t.add(); t.add();
    expect(t.history.bytes()).toBe(2 * BOX_BYTES);
    t.history.undo();
    expect(t.history.bytes()).toBe(2 * BOX_BYTES);
    t.history.redo();
    expect(t.history.bytes()).toBe(2 * BOX_BYTES);
  });
});

describe("step trimming with mixed entries (tester)", () => {
  it("alternating tile and box entries keep the newest 50, in order", () => {
    const t = setup();
    const labels: string[] = [];
    for (let k = 0; k < 60; k++) {
      if (k % 2) { t.add(); labels.push("box"); } else { t.stroke([`${(k % 16) * 256},0`], 1 + (k % 200)); labels.push("tile"); }
    }
    expect(t.history.size).toBe(UNDO_STEPS);
    const kinds = t.history.entries().map((e) => (e.boxes.size ? "box" : "tile"));
    expect(kinds).toEqual(labels.slice(10));
  });

  it("undo + redo stacks together stay within 50 steps, the redo stack's oldest-undone dropped first", () => {
    const t = setup();
    const ids = Array.from({ length: 50 }, () => t.add());
    for (let k = 0; k < 10; k++) t.history.undo();
    expect([t.history.size, t.history.redoSize]).toEqual([40, 10]);
    // undo never grows the total; 50 undos then empty the history
    for (let k = 0; k < 40; k++) t.history.undo();
    expect([t.history.size, t.history.redoSize]).toEqual([0, 50]);
    expect(t.boxes.boxes.size).toBe(0);
    for (let k = 0; k < 50; k++) t.history.redo();
    expect([...t.boxes.boxes.keys()]).toEqual(ids);
  });
});

describe("redo cleared by a new edit, mixed kinds (tester)", () => {
  it("a tile stroke after undoing a box entry empties redo; the box stays undone", () => {
    const t = setup();
    const id = t.add();
    t.history.undo();
    expect(t.history.redoSize).toBe(1);
    t.stroke(["0,0"], 3);
    expect([t.history.size, t.history.redoSize]).toEqual([1, 0]);
    expect(t.history.redo()).toBeNull();
    expect(t.boxes.boxes.has(id)).toBe(false);
  });

  it("a box edit after undoing a tile stroke empties redo; the tile stays undone", () => {
    const t = setup();
    t.stroke(["0,0"], 3);
    t.history.undo();
    t.add();
    expect(t.history.redoSize).toBe(0);
    expect(t.store.tiles.size).toBe(0);
  });

  it("a stroke that changes no tile and no box keeps redo", () => {
    const t = setup();
    t.add();
    t.history.undo();
    const s = t.history.begin();
    t.history.record(s, ["0,0"]);
    t.history.recordBoxes(s, [1, 2]);
    t.history.end(s);
    expect([t.history.size, t.history.redoSize]).toEqual([0, 1]);
  });

  it("an edit that changes a box and changes it back appends nothing", () => {
    const t = setup();
    const id = t.add();
    t.boxStep([id], (b) => { const was = b.boxes.get(id)!; setBox(b, { ...was, value: 7 }); setBox(b, was); });
    expect(t.history.size).toBe(1);
  });

  it("a class change (value only) is an entry and undoes to the old value", () => {
    const t = setup();
    const id = t.add(r, 2);
    t.boxStep([id], (b) => setBox(b, { ...b.boxes.get(id)!, value: 9 }));
    expect(t.history.size).toBe(2);
    t.history.undo();
    expect(t.boxes.boxes.get(id)!.value).toBe(2);
  });

  it("ids are not reused after an undone add followed by a new add, and redo of the old add is gone", () => {
    const t = setup();
    const a = t.add();
    t.history.undo();
    const b = t.add();
    expect(b).toBeGreaterThan(a);
    expect(t.history.redo()).toBeNull();
    expect([...t.boxes.boxes.keys()]).toEqual([b]);
  });

  it("undoing a remove puts the box back in its old iteration place among newer boxes", () => {
    const t = setup();
    const [a, b, c] = [t.add(), t.add(), t.add()];
    t.boxStep([a], (s) => removeBox(s, a));
    const d = t.add();
    t.history.undo(); // d
    t.history.undo(); // the remove of a
    expect([...t.boxes.boxes.keys()]).toEqual([a, b, c]);
    t.history.redo(); t.history.redo();
    expect([...t.boxes.boxes.keys()]).toEqual([b, c, d]);
  });
});

describe("undo after replace() or open() (tester)", () => {
  it("replace (boxes kept): no box or tile entry survives; the boxes are untouched by later undos", () => {
    const t = setup();
    t.stroke(["0,0"], 1);
    const id = t.add();
    t.history.undo(); // the add is now redoable
    const id2 = t.add();
    t.reopen(true);
    expect([t.history.size, t.history.redoSize, t.history.bytes()]).toEqual([0, 0, 0]);
    expect(t.history.undo()).toBeNull();
    expect(t.history.redo()).toBeNull();
    expect([...t.boxes.boxes.keys()]).toEqual([id2]);
    expect(t.boxes.boxes.has(id)).toBe(false);
  });

  it("open (boxes emptied): undo is a no-op on the new raster's store, which then starts its own entries", () => {
    const t = setup();
    t.add(); t.add();
    const old = t.boxes;
    t.reopen(false);
    expect(t.history.undo()).toBeNull();
    expect(t.boxes).not.toBe(old);
    const id = t.add();
    expect(id).toBe(1); // a new raster's store numbers from 1
    expect(t.history.undo()).toEqual({ tiles: [], boxes: [id] });
    expect(t.boxes.boxes.size).toBe(0);
    expect(old.boxes.size).toBe(2); // the old raster's store wasn't touched
  });

  it("a box edit open across clear() appends nothing when it ends", () => {
    const t = setup();
    const s = t.history.begin();
    t.history.recordBoxes(s, [t.boxes.next]);
    addBox(t.boxes, r, 1);
    t.reopen(false);
    t.history.end(s);
    expect([t.history.size, t.history.bytes()]).toEqual([0, 0]);
  });
});
