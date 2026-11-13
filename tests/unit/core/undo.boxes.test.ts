import { describe, expect, it } from "vitest";
import { addBox, emptyBoxes, removeBox, setBox } from "../../../src/core/boxes";
import { TILE_SIZE } from "../../../src/core/types";
import {
  BOX_BYTES, entryBytes, finishBoxes, recordBoxes, swapBoxes, trimHistory, type BoxEdit, type Entry,
} from "../../../src/core/undo";

// Spec 063 scope 4 and criterion 8's byte count.
const r = { x0: 0, y0: 0, x1: 4, y1: 4 };

describe("recordBoxes / finishBoxes / swapBoxes", () => {
  it("records each id's before-state once, as copies, and null for an id not yet added", () => {
    const s = emptyBoxes(), a = addBox(s, r, 1), e: BoxEdit = new Map();
    recordBoxes(s, e, [a.id, s.next]);
    setBox(s, { ...a, x0: 2, x1: 6 });
    recordBoxes(s, e, [a.id]); // already recorded: keeps the first before-state
    expect(e).toEqual(new Map([[a.id, a], [2, null]]));
    s.boxes.get(a.id)!.x0 = 3;
    expect(e.get(a.id)!.x0).toBe(0);
  });

  it("drops unchanged boxes when an entry ends; null when none changed", () => {
    const s = emptyBoxes(), a = addBox(s, r, 1), b = addBox(s, r, 2), e: BoxEdit = new Map();
    recordBoxes(s, e, [a.id, b.id, s.next]);
    setBox(s, { ...a }); // the same box again
    removeBox(s, b.id);
    expect(finishBoxes(s, e)).toEqual(new Map([[b.id, b]]));
    const none: BoxEdit = new Map();
    recordBoxes(s, none, [a.id, s.next]);
    expect(finishBoxes(s, none)).toBeNull();
  });

  it("swapBoxes puts the before-states back and returns the inverse and the ids ascending", () => {
    const s = emptyBoxes(), a = addBox(s, r, 1), b = addBox(s, r, 2), e: BoxEdit = new Map();
    const start = structuredClone(s);
    recordBoxes(s, e, [s.next, b.id, a.id]);
    const c = addBox(s, r, 3);
    removeBox(s, a.id);
    setBox(s, { ...b, value: 9 });
    const { inverse, ids } = swapBoxes(s, finishBoxes(s, e)!);
    expect(ids).toEqual([a.id, b.id, c.id]);
    expect(s.boxes).toEqual(start.boxes);
    expect([...s.boxes.keys()]).toEqual([a.id, b.id]);
    expect(inverse).toEqual(new Map([[c.id, c], [a.id, null], [b.id, { ...b, value: 9 }]]));
    swapBoxes(s, inverse);
    expect([...s.boxes.values()]).toEqual([{ ...b, value: 9 }, c]);
    expect(s.next).toBe(c.id + 1); // undoing an add never frees its id
  });
});

describe("entryBytes", () => {
  it("counts 48 bytes per box change on top of the tile copies (criterion 8)", () => {
    expect(BOX_BYTES).toBe(48);
    const boxes: BoxEdit = new Map([[1, null], [2, { id: 2, value: 1, ...r }], [3, null]]);
    expect(entryBytes({ tiles: new Map(), boxes })).toBe(144);
    const TILE = TILE_SIZE * TILE_SIZE;
    expect(entryBytes({ tiles: new Map([["0,0", new Uint8Array(TILE)], ["256,0", null]]), boxes })).toBe(TILE + 144);
  });

  it("trimHistory counts box bytes and keeps the newest 50 of 51 box entries", () => {
    const one = (): Entry => ({ tiles: new Map(), boxes: new Map([[1, null]]) });
    const h = Array.from({ length: 51 }, one), newest = h.slice(1);
    trimHistory(h, Infinity, 50);
    expect(h).toHaveLength(50);
    h.forEach((e, i) => expect(e).toBe(newest[i]));
    trimHistory(h, 3 * BOX_BYTES, 50);
    expect(h).toEqual(newest.slice(-3));
  });
});
