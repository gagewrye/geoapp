import { describe, expect, it } from "vitest";
import { tileWindows, type Window } from "../../../src/core/grid";
import {
  MAX_LABEL_TILES, brush, emptyStore, keepMasks, tileKeys, tileWindow, type LabelStore, type NodataMasks,
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
    expect(brush(s, m, win(10, 10, 7), 1, false)).toBe("ok");
    expect(brush(s, m, win(13, 13, 3), 2, false)).toBe("ok");
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
    expect(brush(s, m, win(0, 0, 7), 2, false)).toBe("ok");
    expect(brush(s, m, win(17, 17, 7), 1, false)).toBe("ok");
    for (let r = 17; r < 24; r++) for (let c = 17; c < 24; c++) expect(at(s, c, r)).toBe(nd(c, r) ? 0 : 1);
    expect(brush(s, m, win(300, 10, 7), 1, false)).toBe("ok"); // all nodata in tile 256,0
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
    expect(brush(s, none, win(0, 0, 40), 2, true)).toBe("ok");
    expect(at(s, 10, 10)).toBe(0);
    expect(at(s, 13, 13)).toBe(1);
    expect(at(s, 16, 16)).toBe(1);
    expect(brush(s, none, win(0, 100, 50), 1, true)).toBe("ok"); // nothing stored there
    expect(brush(s, none, win(400, 200, 50), 1, true)).toBe("ok"); // tile 256,0 has class 1 elsewhere
    expect(s.tiles.size).toBe(2);
    expect(brush(s, none, win(290, 0, 30), 1, true)).toBe("ok");
    expect([...s.tiles.keys()]).toEqual(["0,0"]);
    expect(brush(s, none, win(0, 0, 256), 1, true)).toBe("ok");
    expect(s.tiles.size).toBe(0);
  });

  it("a size-7 dab on a tile corner creates 4 tiles", () => {
    const s = emptyStore(600, 300);
    expect(brush(s, masksFor(s), win(253, 253, 7), 3, false)).toBe("ok");
    expect([...s.tiles.keys()].sort()).toEqual(["0,0", "0,256", "256,0", "256,256"]);
    expect(s.tiles.get("256,256")).toHaveLength(256 * 44); // clipped edge window
  });

  // Generous timeout: each case builds 289 tile masks and 256 tiles, slow under full-suite parallel load.
  describe(`at MAX_LABEL_TILES (${MAX_LABEL_TILES})`, { timeout: 30_000 }, () => {
    // 17 x 17 tiles. Row-major, the first 256 are tile rows 0-14 and tile (0, 3840); tile (256, 3840) is
    // the next one, and its rows 3840..3967 are nodata.
    const R15 = 15 * 256;
    const full = () => {
      const s = emptyStore(17 * 256, 17 * 256);
      const m = masksFor(s, (c, r) => c >= 256 && c < 512 && r >= R15 && r < R15 + 128);
      for (const w of tileWindows(s.width, s.height).slice(0, MAX_LABEL_TILES)) brush(s, m, win(w.x0 + 5, w.y0 + 5, 1), 1, false);
      expect(s.tiles.size).toBe(MAX_LABEL_TILES);
      expect(s.tiles.has(`0,${R15}`) && !s.tiles.has(`256,${R15}`)).toBe(true);
      return { s, m };
    };
    const copy = (s: LabelStore) => new Map([...s.tiles].map(([k, v]) => [k, v.slice()]));
    // byte comparison: deep equality over 16 MiB of tiles is far too slow
    const same = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) =>
      a.size === b.size && [...a].every(([k, v]) => b.has(k) && Buffer.from(v).equals(Buffer.from(b.get(k)!)));

    it("a dab that would label a pixel in a new tile returns full and changes nothing", () => {
      const { s, m } = full();
      const before = copy(s);
      expect(brush(s, m, win(253, R15 + 200, 7), 2, false)).toBe("full");
      expect(same(s.tiles, before)).toBe(true);
    });
    it("a dab inside stored tiles still applies", () => {
      const { s, m } = full();
      expect(brush(s, m, win(250, 250, 7), 2, false)).toBe("ok");
      expect(at(s, 256, 256)).toBe(2);
      expect(s.tiles.size).toBe(MAX_LABEL_TILES);
    });
    it("a dab whose pixels in new tiles are all nodata still applies", () => {
      const { s, m } = full();
      expect(brush(s, m, win(253, R15 + 10, 7), 2, false)).toBe("ok");
      expect(at(s, 255, R15 + 10)).toBe(2);
      expect(at(s, 256, R15 + 10)).toBe(0);
      expect(s.tiles.size).toBe(MAX_LABEL_TILES);
    });
    it("erase still applies", () => {
      const { s } = full();
      expect(brush(s, new Map(), win(0, 0, 10), 1, true)).toBe("ok");
      expect(s.tiles.size).toBe(MAX_LABEL_TILES - 1);
    });
  });
});

describe("tileKeys and keepMasks (criterion 18)", () => {
  it("tileKeys of a window across a tile corner gives 4 keys, row-major", () => {
    expect(tileKeys(win(250, 500, 10, 30))).toEqual(["0,256", "256,256", "0,512", "256,512"]);
    expect(tileKeys(win(0, 0, 256))).toEqual(["0,0"]);
    expect(tileKeys(win(256, 0, 1))).toEqual(["256,0"]);
  });

  it("keepMasks keeps exactly the masks of stored tiles and of tiles w meets", () => {
    const s = emptyStore(1024, 1024);
    const m = masksFor(s);
    brush(s, m, win(10, 10, 3), 1, false);
    brush(s, m, win(600, 600, 3), 1, false);
    keepMasks(s, m, win(500, 250, 20));
    expect([...m.keys()].sort()).toEqual(["0,0", "256,0", "256,256", "512,0", "512,256", "512,512"].sort());
    keepMasks(s, m, null);
    expect([...m.keys()].sort()).toEqual(["0,0", "512,512"]);
  });
});
