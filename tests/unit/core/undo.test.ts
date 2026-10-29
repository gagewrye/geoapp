import { describe, expect, it } from "vitest";
import { tileWindows, type Window } from "../../../src/core/grid";
import { brush, emptyStore, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { TILE_SIZE } from "../../../src/core/types";
import { UNDO_BYTES, UNDO_STEPS, editBytes, finishEdit, recordTiles, trimHistory, undoEdit, type Edit } from "../../../src/core/undo";
import { makeTile } from "../helpers/tiles";

const TILE = TILE_SIZE * TILE_SIZE;
const MiB = 1024 * 1024;

function masksFor(store: LabelStore, nodata: (c: number, r: number) => boolean = () => false): NodataMasks {
  const masks: NodataMasks = new Map();
  for (const w of tileWindows(store.width, store.height))
    masks.set(`${w.x0},${w.y0}`, nodataMask(makeTile(w.x0, w.y0, w.width, w.height, 1, (_k, c, r) => (nodata(c, r) ? NaN : 1))));
  return masks;
}
const win = (x0: number, y0: number, width: number, height = width): Window => ({ x0, y0, width, height });
const snapshot = (s: LabelStore) => new Map([...s.tiles].map(([k, t]) => [k, t.slice()]));

describe("recordTiles / finishEdit / undoEdit (spec 010 criterion 1)", () => {
  it("undoes a size-7 dab across the corner of a 2x2-tile store", () => {
    const s = emptyStore(512, 512);
    const m = masksFor(s);
    brush(s, m, win(250, 250, 3), 1, false); // tile 0,0 stored, with class 1 near the corner
    brush(s, m, win(300, 300, 2), 2, false); // tile 256,256 stored
    const before = snapshot(s);
    const dab = win(253, 253, 7);
    const edit: Edit = new Map();
    recordTiles(s, edit, dab);
    expect(brush(s, m, dab, 3, false)).toBe("ok");
    expect(s.tiles.has("256,0")).toBe(true); // created by the dab
    const done = finishEdit(s, edit)!;
    expect(done).not.toBeNull();
    expect(undoEdit(s, done)).toEqual(["0,0", "256,0", "0,256", "256,256"]);
    expect([...s.tiles.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, t] of before) expect(s.tiles.get(k)).toEqual(t);
    expect(s.tiles.has("256,0")).toBe(false);
    expect(s.tiles.has("0,256")).toBe(false);
  });

  it("gives null for a stroke that changes nothing: only nodata, or erasing an absent class", () => {
    const s = emptyStore(512, 512);
    const m = masksFor(s, (c) => c < 100); // columns 0..99 are nodata
    brush(s, m, win(200, 200, 3), 1, false);
    const nodata: Edit = new Map();
    recordTiles(s, nodata, win(10, 10, 7));
    brush(s, m, win(10, 10, 7), 2, false);
    expect(finishEdit(s, nodata)).toBeNull();
    const erase: Edit = new Map();
    recordTiles(s, erase, win(198, 198, 7));
    brush(s, m, win(198, 198, 7), 2, true); // class 2 is absent there
    expect(finishEdit(s, erase)).toBeNull();
  });

  it("keeps the first copy when a key is recorded twice", () => {
    const s = emptyStore(512, 512);
    const m = masksFor(s);
    brush(s, m, win(0, 0, 1), 1, false);
    const first = s.tiles.get("0,0")!.slice();
    const edit: Edit = new Map();
    recordTiles(s, edit, win(0, 0, 3));
    brush(s, m, win(0, 0, 3), 2, false);
    recordTiles(s, edit, win(0, 0, 3));
    expect(edit.get("0,0")).toEqual(first);
    expect(edit.get("0,0")).not.toBe(s.tiles.get("0,0")); // a copy, not the live tile
    const absent: Edit = new Map();
    recordTiles(s, absent, win(300, 300, 1));
    expect(absent.get("256,256")).toBeNull();
    brush(s, m, win(300, 300, 1), 1, false);
    recordTiles(s, absent, win(300, 300, 1));
    expect(absent.get("256,256")).toBeNull();
  });

  it("drops unchanged tiles when the stroke finishes", () => {
    const s = emptyStore(512, 512);
    const m = masksFor(s);
    brush(s, m, win(10, 10, 3), 1, false);
    const edit: Edit = new Map();
    recordTiles(s, edit, win(0, 0, 512)); // meets all 4 tiles
    brush(s, m, win(300, 10, 1), 1, false);
    const done = finishEdit(s, edit)!;
    expect([...done.keys()]).toEqual(["256,0"]);
  });
});

const oneTileEdit = (k: number): Edit => new Map([[`${k * 256},0`, new Uint8Array(TILE)]]);
const sized = (bytes: number): Edit => {
  const e: Edit = new Map();
  for (let i = 0; i * TILE < bytes; i++) e.set(`${i * 256},0`, new Uint8Array(TILE));
  return e;
};

describe("trimHistory / editBytes (spec 010 criterion 2)", () => {
  it("keeps the newest UNDO_STEPS of 51 one-tile edits", () => {
    expect(UNDO_STEPS).toBe(50);
    const h = Array.from({ length: 51 }, (_, k) => oneTileEdit(k));
    const newest = h.slice(1);
    trimHistory(h, UNDO_BYTES, UNDO_STEPS);
    expect(h).toHaveLength(50);
    h.forEach((e, i) => expect(e).toBe(newest[i]));
  });

  it("keeps the newest 8 of nine 4 MiB edits within UNDO_BYTES", () => {
    expect(UNDO_BYTES).toBe(32 * MiB);
    const h = Array.from({ length: 9 }, () => sized(4 * MiB));
    expect(editBytes(h[0]!)).toBe(4 * MiB);
    const newest = h.slice(1);
    trimHistory(h, UNDO_BYTES, UNDO_STEPS);
    expect(h).toHaveLength(8);
    h.forEach((e, i) => expect(e).toBe(newest[i]));
  });

  it("counts null entries as 0 bytes", () => {
    expect(editBytes(new Map([["0,0", null], ["256,0", new Uint8Array(10)], ["512,0", null]]))).toBe(10);
    expect(editBytes(new Map())).toBe(0);
  });
});
