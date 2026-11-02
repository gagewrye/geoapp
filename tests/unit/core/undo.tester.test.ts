import { describe, expect, it } from "vitest";
import { tileWindows, type Window } from "../../../src/core/grid";
import { brush, emptyStore, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { footprint } from "../../../src/core/pixel";
import { TILE_SIZE } from "../../../src/core/types";
import { UNDO_BYTES, UNDO_STEPS, editBytes, finishEdit, recordTiles, swapEdit, trimHistory, type Edit } from "../../../src/core/undo";
import { makeTile } from "../helpers/tiles";

// Tester edge cases for spec 010's core undo: partial edge tiles, empty edits, the tile cap, and trimming bounds.
const TILE = TILE_SIZE * TILE_SIZE;
const win = (x0: number, y0: number, width: number, height = width): Window => ({ x0, y0, width, height });
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));
function masksFor(store: LabelStore): NodataMasks {
  const m: NodataMasks = new Map();
  for (const w of tileWindows(store.width, store.height)) m.set(`${w.x0},${w.y0}`, nodataMask(makeTile(w.x0, w.y0, w.width, w.height, 1, () => 1)));
  return m;
}

describe("recordTiles / finishEdit / swapEdit edges (spec 010 criterion 1, tester)", () => {
  it("undoes a dab over the partial bottom-right tiles of a 600x520 raster; copies are window-sized", () => {
    const s = emptyStore(600, 520);
    const m = masksFor(s);
    brush(s, m, win(590, 510, 5), 1, false);
    const before = snapshot(s);
    const dab = win(508, 508, 7); // meets 256,256 / 512,256 / 256,512 / 512,512, the last 88x8
    const e: Edit = new Map();
    recordTiles(s, e, dab);
    expect(e.get("512,512")!.length).toBe(88 * 8);
    brush(s, m, dab, 2, false);
    const done = finishEdit(s, e)!;
    expect(swapEdit(s, done).keys).toEqual(["256,256", "512,256", "256,512", "512,512"]);
    expect(snapshot(s)).toEqual(before);
  });

  it("a size-7 footprint at the raster corner (clipped by footprint()) records only real tiles", () => {
    const s = emptyStore(300, 300);
    const e: Edit = new Map();
    recordTiles(s, e, footprint(s, 0, 0, 7)!);
    expect([...e.keys()]).toEqual(["0,0"]);
    recordTiles(s, e, footprint(s, 299, 299, 7)!);
    expect([...e.keys()]).toEqual(["0,0", "256,256"]);
  });

  it("a tile created then erased back to nothing within one edit counts as unchanged", () => {
    const s = emptyStore(512, 512);
    const m = masksFor(s);
    const e: Edit = new Map();
    recordTiles(s, e, win(10, 10, 3));
    brush(s, m, win(10, 10, 3), 1, false);
    brush(s, m, win(10, 10, 3), 1, true);
    expect(s.tiles.size).toBe(0);
    expect(finishEdit(s, e)).toBeNull();
  });

  it("an empty edit finishes as null and undoes nothing", () => {
    const s = emptyStore(512, 512);
    expect(finishEdit(s, new Map())).toBeNull();
    expect(swapEdit(s, new Map()).keys).toEqual([]);
  });

  it("returns keys row-major across many tiles regardless of record order", () => {
    const s = emptyStore(1024, 1024);
    const m = masksFor(s);
    const e: Edit = new Map();
    for (const w of [win(900, 900, 1), win(10, 900, 1), win(900, 10, 1), win(300, 300, 1)]) { recordTiles(s, e, w); brush(s, m, w, 1, false); }
    expect(swapEdit(s, finishEdit(s, e)!).keys).toEqual(["768,0", "256,256", "0,768", "768,768"]);
  });
});

describe("trimHistory edges (spec 010 criterion 2, tester)", () => {
  const edit = (tiles: number): Edit => new Map(Array.from({ length: tiles }, (_, i) => [`${i * 256},0`, new Uint8Array(TILE)] as const));
  it("does nothing to an empty history or one within bounds", () => {
    const h: Edit[] = [];
    trimHistory(h, UNDO_BYTES, UNDO_STEPS);
    expect(h).toEqual([]);
    const h2 = [edit(1), edit(2)];
    const keep = [...h2];
    trimHistory(h2, UNDO_BYTES, UNDO_STEPS);
    expect(h2).toEqual(keep);
  });
  it("a non-positive byte budget drops every entry holding bytes; all-null entries survive it", () => {
    const nulls: Edit = new Map([["0,0", null]]);
    const h = [edit(1), nulls];
    trimHistory(h, 0, UNDO_STEPS);
    expect(h).toEqual([nulls]);
    const h2 = [edit(1), edit(1)];
    trimHistory(h2, -5, UNDO_STEPS);
    expect(h2).toEqual([]);
  });
  it("exactly UNDO_BYTES is kept (<=, not <)", () => {
    const h = [edit(256), edit(256)];
    trimHistory(h, UNDO_BYTES, UNDO_STEPS);
    expect(h).toHaveLength(2);
    expect(h.reduce((n, e) => n + editBytes(e), 0)).toBe(UNDO_BYTES);
  });
  it("maxSteps 0 empties the history", () => {
    const h = [edit(1)];
    trimHistory(h, UNDO_BYTES, 0);
    expect(h).toEqual([]);
  });
});
