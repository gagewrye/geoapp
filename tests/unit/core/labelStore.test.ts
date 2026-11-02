import { describe, expect, it } from "vitest";
import { tileWindows, type Window } from "../../../src/core/grid";
import {
  brush, emptyStore, tileKeys, tileWindow, type LabelStore, type NodataMasks,
} from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { makeTile } from "../helpers/tiles";

/** Masks for every tile of the store, with `nodata(col, row)` pixels set. */
function masksFor(store: LabelStore, nodata: (c: number, r: number) => boolean = () => false): NodataMasks {
  const masks: NodataMasks = new Map();
  for (const w of tileWindows(store.width, store.height)) {
    masks.set(`${w.x0},${w.y0}`, nodataMask(makeTile(w.x0, w.y0, w.width, w.height, 1, (_k, c, r) => (nodata(c, r) ? NaN : 1))));
  }
  return masks;
}

/** Label at a raster pixel, 0 when its tile isn't stored. */
const at = (s: LabelStore, c: number, r: number) => {
  const w = tileWindow(s, c - (c % 256), r - (r % 256));
  return s.tiles.get(`${w.x0},${w.y0}`)?.[(r - w.y0) * w.width + (c - w.x0)] ?? 0;
};
const win = (x0: number, y0: number, width: number, height = width): Window => ({ x0, y0, width, height });

describe("brush (criterion 4)", () => {
  it("paint overwrites another class and labels exactly the window", () => {
    const s = emptyStore(600, 300);
    const m = masksFor(s);
    brush(s, m, win(10, 10, 7), 1, false);
    brush(s, m, win(13, 13, 3), 2, false);
    expect(at(s, 13, 13)).toBe(2);
    expect(at(s, 12, 12)).toBe(1);
    expect(at(s, 16, 16)).toBe(1);
    expect(at(s, 17, 16)).toBe(0);
    expect(at(s, 9, 10)).toBe(0);
    expect([...s.tiles.keys()]).toEqual(["0,0"]);
    expect(s.tiles.get("0,0")!.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)).toBe(49);
  });

  it("leaves pixels whose mask bit is set unchanged, and creates no tile for a dab wholly on nodata", () => {
    const s = emptyStore(600, 300);
    const nd = (c: number, r: number) => (c >= 20 && c < 30 && r >= 20 && r < 30) || c >= 256;
    const m = masksFor(s, nd);
    brush(s, m, win(0, 0, 7), 2, false);
    brush(s, m, win(17, 17, 7), 1, false);
    for (let r = 17; r < 24; r++) for (let c = 17; c < 24; c++) expect(at(s, c, r)).toBe(nd(c, r) ? 0 : 1);
    brush(s, m, win(300, 10, 7), 1, false); // all nodata in tile 256,0
    expect([...s.tiles.keys()]).toEqual(["0,0"]);
  });

  it("paint throws when a tile it meets has no mask", () => {
    const s = emptyStore(600, 300);
    const m = masksFor(s);
    m.delete("256,0");
    expect(() => brush(s, m, win(250, 10, 7), 1, false)).toThrow(/mask/);
    expect(s.tiles.size).toBe(0);
  });

  it("erase ignores masks, clears only value, never creates a tile and deletes a tile once empty", () => {
    const s = emptyStore(600, 300);
    const m = masksFor(s);
    brush(s, m, win(10, 10, 7), 1, false);
    brush(s, m, win(10, 10, 3), 2, false);
    brush(s, m, win(300, 10, 3), 1, false);
    const none: NodataMasks = new Map();
    brush(s, none, win(0, 0, 40), 2, true);
    expect(at(s, 10, 10)).toBe(0);
    expect(at(s, 13, 13)).toBe(1);
    expect(at(s, 16, 16)).toBe(1);
    brush(s, none, win(0, 100, 50), 1, true); // nothing stored there
    brush(s, none, win(400, 200, 50), 1, true); // tile 256,0 has class 1 elsewhere
    expect(s.tiles.size).toBe(2);
    brush(s, none, win(290, 0, 30), 1, true);
    expect([...s.tiles.keys()]).toEqual(["0,0"]);
    brush(s, none, win(0, 0, 256), 1, true);
    expect(s.tiles.size).toBe(0);
  });

  it("a size-7 dab on a tile corner creates 4 tiles", () => {
    const s = emptyStore(600, 300);
    brush(s, masksFor(s), win(253, 253, 7), 3, false);
    expect([...s.tiles.keys()].sort()).toEqual(["0,0", "0,256", "256,0", "256,256"]);
    expect(s.tiles.get("256,256")).toHaveLength(256 * 44); // clipped edge window
  });
});

// keepMasks went with spec 023 (ADR 0021): masks are kept for the raster's life.
describe("tileKeys (criterion 18)", () => {
  it("tileKeys of a window across a tile corner gives 4 keys, row-major", () => {
    expect(tileKeys(win(250, 500, 10, 30))).toEqual(["0,256", "256,256", "0,512", "256,512"]);
    expect(tileKeys(win(0, 0, 256))).toEqual(["0,0"]);
    expect(tileKeys(win(256, 0, 1))).toEqual(["256,0"]);
  });
});
