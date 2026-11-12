import { describe, expect, it } from "vitest";
import { brush, brushSpans, emptyStore, tileWindow, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { windowSpans } from "../../../src/core/spans";
import { TILE_SIZE } from "../../../src/core/types";

// Spec 058 criterion 1, tester's edge cases: tile seams, partial edge tiles, absent tiles, value ignored, masks unused.
const T = TILE_SIZE;
const W = T + 37, H = T + 11; // the right and bottom tiles are partial

/** A store whose four tiles (two of them partial) are each filled with a pattern of 0, 1, 2 and 255. */
function full(base = false): LabelStore {
  const store = { ...emptyStore(W, H), base };
  for (const [x0, y0] of [[0, 0], [T, 0], [0, T], [T, T]] as const) {
    const t = tileWindow(store, x0, y0);
    store.tiles.set(`${x0},${y0}`, new Uint8Array(t.width * t.height).map((_, i) => [0, 1, 2, 255][i % 4]!));
  }
  return store;
}

/** The label at raster pixel (c, r), 0 for an absent tile. */
function at(store: LabelStore, c: number, r: number): number {
  const x0 = Math.floor(c / T) * T, y0 = Math.floor(r / T) * T;
  const tile = store.tiles.get(`${x0},${y0}`);
  return tile ? tile[(r - y0) * tileWindow(store, x0, y0).width + (c - x0)]! : 0;
}

type Run = (s: LabelStore, w: { x0: number; y0: number; width: number; height: number }, value: number) => void;
const noMasks: NodataMasks = new Map(); // erase must never consult masks
const runs: [string, Run][] = [
  ["brush", (s, w, v) => brush(s, noMasks, w, v, "any")],
  ["brushSpans", (s, w, v) => brushSpans(s, noMasks, windowSpans(w), v, "any")],
];

for (const [name, run] of runs) {
  describe(`${name} "any" edge cases`, () => {
    it("a footprint across the seam of four tiles, two of them partial, zeroes exactly its pixels", () => {
      const store = full(), before = full();
      const w = { x0: T - 3, y0: T - 4, width: 9, height: 8 };
      run(store, w, 1);
      for (let r = T - 8; r < H; r++) for (let c = T - 8; c < W; c++) {
        const inside = c >= w.x0 && c < w.x0 + w.width && r >= w.y0 && r < w.y0 + w.height;
        expect(at(store, c, r), `${c},${r}`).toBe(inside ? 0 : at(before, c, r));
      }
    });

    it("a footprint hanging off the raster's bottom right corner zeroes the clipped part and throws nothing", () => {
      const store = full();
      run(store, { x0: W - 2, y0: H - 2, width: 7, height: 7 }, 1);
      for (const [c, r] of [[W - 1, H - 1], [W - 2, H - 2], [W - 1, H - 2]] as const) expect(at(store, c, r)).toBe(0);
      expect(at(store, W - 3, H - 1)).toBe(at(full(), W - 3, H - 1));
    });

    it("erasing the whole raster deletes every tile without base and keeps all-zero tiles with base", () => {
      const a = full(false);
      run(a, { x0: 0, y0: 0, width: W, height: H }, 1);
      expect(a.tiles.size).toBe(0);
      const b = full(true);
      run(b, { x0: 0, y0: 0, width: W, height: H }, 1);
      expect(b.tiles.size).toBe(4);
      for (const t of b.tiles.values()) expect(t.every((v) => v === 0)).toBe(true);
    });

    it("never creates a tile where none is stored (no allocation outside stored tiles)", () => {
      const store = emptyStore(W, H);
      store.tiles.set("0,0", new Uint8Array(T * T).fill(3));
      run(store, { x0: T - 2, y0: T - 2, width: 4, height: 4 }, 1);
      expect([...store.tiles.keys()]).toEqual(["0,0"]);
    });

    it("ignores value: erasing with a value no pixel holds still zeroes 1, 2 and 255", () => {
      const store = full();
      run(store, { x0: 0, y0: 0, width: 8, height: 1 }, 7);
      for (let c = 0; c < 8; c++) expect(at(store, c, 0)).toBe(0);
      expect(at(store, 8, 0)).toBe(0);
      expect(at(store, 9, 0)).toBe(1);
    });

    it("still rejects a value outside 1..255 and changes nothing", () => {
      const store = full(), before = full();
      for (const v of [0, 256, 1.5, Number.NaN]) expect(() => run(store, { x0: 0, y0: 0, width: 4, height: 4 }, v)).toThrow(/1\.\.255/);
      expect(store.tiles).toEqual(before.tiles);
    });

    it("an empty footprint changes nothing", () => {
      const store = full(), before = full();
      run(store, { x0: 5, y0: 5, width: 0, height: 0 }, 1);
      expect(store.tiles).toEqual(before.tiles);
    });

    it("a single-class tile of 255s is cleared, and deleted when wholly emptied", () => {
      const store = emptyStore(W, H);
      store.tiles.set(`${T},${T}`, new Uint8Array(37 * 11).fill(255));
      run(store, { x0: T, y0: T, width: 37, height: 11 }, 1);
      expect(store.tiles.size).toBe(0);
    });
  });
}

describe("erase true is unchanged next to \"any\"", () => {
  it("true with value 255 at a seam zeroes only the 255s", () => {
    for (const run of [
      (s: LabelStore, w: { x0: number; y0: number; width: number; height: number }) => brush(s, noMasks, w, 255, true),
      (s: LabelStore, w: { x0: number; y0: number; width: number; height: number }) => brushSpans(s, noMasks, windowSpans(w), 255, true),
    ]) {
      const store = full(), before = full();
      const w = { x0: T - 3, y0: T - 4, width: 9, height: 8 };
      run(store, w);
      for (let r = w.y0; r < w.y0 + w.height; r++) for (let c = w.x0; c < w.x0 + w.width; c++)
        expect(at(store, c, r), `${c},${r}`).toBe(at(before, c, r) === 255 ? 0 : at(before, c, r));
    }
  });
});
