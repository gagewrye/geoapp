import { describe, expect, it } from "vitest";
import { addBox, emptyBoxes, moveRect, removeBox, setBox, type BoxStore, type Rect } from "../../../src/core/boxes";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { TILE_SIZE } from "../../../src/core/types";
import { BOX_BYTES, UNDO_BYTES, UNDO_STEPS, entryBytes } from "../../../src/core/undo";
import { UndoHistory } from "../../../src/io/undoHistory";

// Spec 063 criteria 6 to 8: box entries in UndoHistory, alone and mixed with tile strokes.
const TILE = TILE_SIZE * TILE_SIZE;
const r: Rect = { x0: 10, y0: 10, x1: 20, y1: 30 };
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));
/** Byte-equal tile maps; fast where toEqual over 600 tiles isn't. */
const sameTiles = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) =>
  a.size === b.size && [...a].every(([k, t]) => b.has(k) && Buffer.from(t).equals(Buffer.from(b.get(k)!)));

function setup(width = 4096, height = 4096) {
  const store = emptyStore(width, height), boxes = emptyBoxes();
  const history = new UndoHistory(() => store, () => boxes);
  /** One entry: records ids, runs f, ends. */
  const boxStep = (ids: number[], f: (b: BoxStore) => void) => {
    const s = history.begin();
    history.recordBoxes(s, ids);
    f(boxes);
    history.end(s);
  };
  /** One stroke that fills the tiles at keys with v (no paint queue: the tiles are set directly). */
  const stroke = (keys: string[], v: number) => {
    const s = history.begin();
    history.record(s, keys);
    for (const k of keys) store.tiles.set(k, new Uint8Array(TILE).fill(v));
    history.end(s);
  };
  const add = () => { let id = 0; boxStep([boxes.next], (b) => { id = addBox(b, r, 1).id; }); return id; };
  return { store, boxes, history, boxStep, stroke, add };
}

describe("box entries (criterion 6)", () => {
  it("add, move, then remove a box are 3 entries; 3 undos empty the store and 3 redos restore it", () => {
    const t = setup(300, 200);
    const id = t.add();
    t.boxStep([id], (b) => setBox(b, { ...b.boxes.get(id)!, ...moveRect(r, 5, 7, t.store) }));
    const moved = structuredClone(t.boxes.boxes);
    t.boxStep([id], (b) => removeBox(b, id));
    expect(t.history.size).toBe(3);
    expect(t.history.undo()).toEqual({ tiles: [], boxes: [id] });
    expect(t.boxes.boxes).toEqual(moved);
    t.history.undo();
    expect(t.boxes.boxes).toEqual(new Map([[id, { id, value: 1, ...r }]]));
    t.history.undo();
    expect(t.boxes.boxes).toEqual(new Map());
    expect(t.history.undo()).toBeNull();
    for (let k = 0; k < 3; k++) expect(t.history.redo()).toEqual({ tiles: [], boxes: [id] });
    expect(t.boxes.boxes).toEqual(new Map());
    expect(t.history.redo()).toBeNull();
    t.history.undo();
    expect(t.boxes.boxes).toEqual(moved);
    expect(t.boxes.next).toBe(id + 1); // the id stays used
  });

  it("mixed: stroke A, add a box, stroke B; undos revert B, then the box, then A, each naming only what it changed", () => {
    const t = setup();
    const empty = snapshot(t.store);
    t.stroke(["256,0", "0,0"], 1);
    const afterA = snapshot(t.store);
    const id = t.add();
    t.stroke(["0,256", "256,0"], 2);
    expect(t.history.size).toBe(3);
    expect(t.history.undo()).toEqual({ tiles: ["256,0", "0,256"], boxes: [] });
    expect(snapshot(t.store)).toEqual(afterA);
    expect(t.boxes.boxes.size).toBe(1);
    expect(t.history.undo()).toEqual({ tiles: [], boxes: [id] });
    expect(t.boxes.boxes.size).toBe(0);
    expect(snapshot(t.store)).toEqual(afterA);
    expect(t.history.undo()).toEqual({ tiles: ["0,0", "256,0"], boxes: [] });
    expect(snapshot(t.store)).toEqual(empty);
    expect(t.history.redo()).toEqual({ tiles: ["0,0", "256,0"], boxes: [] });
    expect(t.history.redo()).toEqual({ tiles: [], boxes: [id] });
  });

  it("an entry changing tiles and boxes names both, box ids ascending", () => {
    const t = setup();
    const [a, b] = [t.add(), t.add()];
    const s = t.history.begin();
    t.history.recordBoxes(s, [b, a]);
    t.history.record(s, ["0,0"]);
    removeBox(t.boxes, b); removeBox(t.boxes, a);
    t.store.tiles.set("0,0", new Uint8Array(TILE).fill(3));
    t.history.end(s);
    expect(t.history.undo()).toEqual({ tiles: ["0,0"], boxes: [a, b] });
  });
});

describe("no-op entries and redo (criterion 7)", () => {
  it("a move by (0, 0) appends no entry", () => {
    const t = setup();
    const id = t.add();
    t.boxStep([id], (b) => setBox(b, { ...b.boxes.get(id)!, ...moveRect(b.boxes.get(id)!, 0, 0, t.store) }));
    expect(t.history.size).toBe(1);
    expect(t.history.bytes()).toBe(BOX_BYTES);
  });

  it("after an undo, a new box entry empties redo; a box no-op doesn't", () => {
    const t = setup();
    t.stroke(["0,0"], 1);
    const id = t.add();
    t.history.undo();
    t.history.undo();
    expect(t.history.redoSize).toBe(2);
    t.boxStep([id, t.boxes.next], () => {}); // records, changes nothing
    expect(t.history.redoSize).toBe(2);
    t.add();
    expect([t.history.size, t.history.redoSize]).toEqual([1, 0]);
  });
});

describe("budget (criterion 8)", () => {
  it("an entry of 3 box changes counts 144 bytes", () => {
    const t = setup();
    const ids = [t.add(), t.add()];
    t.history.clear();
    t.boxStep([...ids, t.boxes.next], (b) => { removeBox(b, ids[0]!); setBox(b, { ...b.boxes.get(ids[1]!)!, value: 4 }); addBox(b, r, 2); });
    expect(t.history.entries().map(entryBytes)).toEqual([144]);
    expect(t.history.bytes()).toBe(144);
  });

  it("51 box entries keep the newest 50", () => {
    const t = setup();
    const ids = Array.from({ length: 51 }, () => t.add());
    expect(t.history.size).toBe(UNDO_STEPS);
    expect(t.history.entries().map((e) => [...e.boxes.keys()][0])).toEqual(ids.slice(1));
  });

  it("spec 037 criterion 4 with mixed entries: after an undo, a large stroke stays within UNDO_BYTES and drops redo entries first", () => {
    const t = setup();
    const keys = (row: number) => Array.from({ length: 16 }, (_, i) => `${i * 256},${row * 256}`); // one 1 MiB tile row
    for (let k = 0; k < 16; k++) t.stroke(keys(k), 1); // every tile stored
    t.history.clear();
    for (let k = 0; k < 24; k++) { t.stroke(keys(k % 16), 2 + k); if (k % 6 === 0) t.add(); }
    for (let k = 0; k < 4; k++) t.history.undo(); // strokes 20 to 23: 20 MiB and 4 box entries stay in the history, 4 MiB go to redo
    expect(t.history.size + t.history.redoSize).toBe(28);
    const redoAtStart = t.history.redoSize;
    const s = t.history.begin();
    let peak = 0, redoWhenHistoryShrank = -1;
    const size0 = t.history.size;
    for (let row = 0; row < 16; row++) {
      t.history.record(s, keys(row));
      for (const k of keys(row)) t.store.tiles.set(k, new Uint8Array(TILE).fill(200));
      peak = Math.max(peak, t.history.bytes());
      if (redoWhenHistoryShrank < 0 && t.history.size < size0) redoWhenHistoryShrank = t.history.redoSize;
    }
    t.history.end(s);
    expect(redoAtStart).toBe(4);
    expect(redoWhenHistoryShrank).toBe(0);
    expect(peak).toBeLessThanOrEqual(UNDO_BYTES);
    expect(t.history.bytes()).toBeLessThanOrEqual(UNDO_BYTES);
    expect(t.history.redoSize).toBe(0);
  });

  it("spec 048's keep rule with mixed entries: an oversized stroke drops every older entry, box ones too, and stays alone", () => {
    const t = setup(8192, 8192); // 1,024 tile windows
    const all = Array.from({ length: 600 }, (_, i) => `${(i % 32) * 256},${Math.floor(i / 32) * 256}`);
    t.stroke(all, 1); // 600 stored tiles, so the big stroke copies each
    t.history.clear();
    for (let k = 0; k < 5; k++) { t.stroke(all.slice(k * 16, k * 16 + 16), 2); t.add(); }
    expect(t.history.size).toBe(10);
    const before = snapshot(t.store);
    t.stroke(all, 9); // 37.5 MiB of copies
    expect(t.history.size).toBe(1);
    expect(t.history.entries()[0]!.boxes.size).toBe(0);
    expect(t.history.bytes()).toBe(600 * TILE);
    expect(t.history.undo()!.tiles).toHaveLength(600);
    expect(sameTiles(snapshot(t.store), before)).toBe(true);
    t.history.redo();
    expect(t.history.bytes()).toBe(600 * TILE);
    expect(t.boxes.boxes.size).toBe(5); // the box entries were dropped, not undone
    t.add(); // a later box entry drops it
    expect(t.history.size).toBe(1);
    expect(t.history.bytes()).toBe(BOX_BYTES);
  });
});
