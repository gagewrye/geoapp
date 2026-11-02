import { describe, expect, it } from "vitest";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { TILE_SIZE } from "../../../src/core/types";
import { swapEdit, trimHistory, type Edit } from "../../../src/core/undo";

// Spec 037 criterion 1 and scope 4's trim order.
const TILE = TILE_SIZE * TILE_SIZE;
const tile = (v: number) => new Uint8Array(TILE).fill(v);
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));

describe("swapEdit", () => {
  it("swapping an edit and then its inverse leaves the store byte-equal, absent tiles included; keys are row-major", () => {
    const s = emptyStore(768, 768);
    s.tiles.set("256,256", tile(1));
    s.tiles.set("0,512", tile(2));
    const start = snapshot(s);
    // the edit puts back: 256,256 as 3s, 512,0 created, 0,512 deleted
    const edit: Edit = new Map([["512,0", tile(4)], ["0,512", null], ["256,256", tile(3)]]);
    const { inverse, keys } = swapEdit(s, edit);
    expect(keys).toEqual(["512,0", "256,256", "0,512"]);
    expect(s.tiles.get("512,0")).toEqual(tile(4));
    expect(s.tiles.has("0,512")).toBe(false);
    expect(inverse.get("512,0")).toBeNull();
    expect(inverse.get("0,512")).toEqual(tile(2));
    const back = swapEdit(s, inverse);
    expect(back.keys).toEqual(keys);
    expect(snapshot(s)).toEqual(start);
    expect(back.inverse.get("512,0")).toEqual(tile(4));
  });

  it("the inverse holds copies, not the store's own tiles", () => {
    const s = emptyStore(256, 256);
    s.tiles.set("0,0", tile(1));
    const { inverse } = swapEdit(s, new Map([["0,0", tile(2)]]));
    s.tiles.get("0,0")![0] = 9;
    expect(inverse.get("0,0")![0]).toBe(1);
  });
});

describe("trimHistory with a redo stack", () => {
  const one = () => new Map([["0,0", tile(1)]]) as Edit;
  it("drops the redo stack's oldest-undone entries before any history entry", () => {
    const history = [one(), one(), one()], redo = [one(), one()];
    const [, top] = redo, keep = [...history];
    trimHistory(history, 4 * TILE, 50, redo);
    expect(redo).toEqual([top]);
    expect(redo[0]).toBe(top);
    expect(history).toHaveLength(3);
    trimHistory(history, 2 * TILE, 50, redo);
    expect(redo).toEqual([]);
    expect(history).toEqual(keep.slice(1));
    expect(history[0]).toBe(keep[1]);
  });

  it("counts both stacks against the step limit", () => {
    const history = [one(), one()], redo = [one(), one()];
    trimHistory(history, Infinity, 3, redo);
    expect([history.length, redo.length]).toEqual([2, 1]);
  });
});

// Spec 048 criterion 6 (scope 4): the entry just appended or pushed stays, whatever its size.
describe("trimHistory never drops keep", () => {
  const many = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`${i * 256},0`, tile(1)] as const)) as Edit;
  it("keeps an oversized newest history entry and drops every other", () => {
    const big = many(10), history = [many(1), many(1), big];
    trimHistory(history, 4 * TILE, 50, [], big);
    expect(history).toEqual([big]);
    expect(history[0]).toBe(big);
  });
  it("keeps an oversized redo entry, dropping the history and older redo entries", () => {
    const big = many(10), history = [many(1)], redo = [many(1), big];
    trimHistory(history, 4 * TILE, 50, redo, big);
    expect(history).toEqual([]);
    expect(redo).toHaveLength(1);
    expect(redo[0]).toBe(big);
  });
  it("still drops keep's neighbours for steps, never keep", () => {
    const k = many(1), history = [many(1), k, many(1)];
    trimHistory(history, Infinity, 1, [], k);
    expect(history).toEqual([k]);
    expect(history[0]).toBe(k);
  });
});
