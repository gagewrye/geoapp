import { describe, expect, it } from "vitest";
import { brush, brushSpans, emptyStore, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { windowSpans } from "../../../src/core/spans";

// Spec 058 criterion 1: "any" zeroes every label the footprint covers; true still zeroes only the given value.
const noMasks: NodataMasks = new Map();
const W = 20, H = 20;
const win = { x0: 5, y0: 5, width: 6, height: 6 };
const inside = (i: number) => { const c = i % W, r = Math.floor(i / W); return c >= 5 && c < 11 && r >= 5 && r < 11; };

/** A 20x20 store with one tile holding 1s, 2s and 0s in a repeating pattern. */
function mixed(base = false): { store: LabelStore; tile: Uint8Array; before: Uint8Array } {
  const store = { ...emptyStore(W, H), base };
  const tile = new Uint8Array(W * H).map((_, i) => i % 3);
  store.tiles.set("0,0", tile);
  return { store, tile, before: tile.slice() };
}

type Erase = (store: LabelStore, w: typeof win, value: number, erase: true | "any") => void;
const viaBrush: Erase = (s, w, v, e) => brush(s, noMasks, w, v, e);
const viaSpans: Erase = (s, w, v, e) => brushSpans(s, noMasks, windowSpans(w), v, e);

for (const [name, erase] of [["brushSpans", viaSpans], ["brush", viaBrush]] as const) {
  describe(`${name} erase kinds`, () => {
    it('"any" zeroes every pixel in the footprint and nothing outside it', () => {
      const { store, tile, before } = mixed();
      erase(store, win, 1, "any");
      for (let i = 0; i < tile.length; i++) expect(tile[i], `${i}`).toBe(inside(i) ? 0 : before[i]);
    });

    it("true with value 1 zeroes only the 1s", () => {
      const { store, tile, before } = mixed();
      erase(store, win, 1, true);
      for (let i = 0; i < tile.length; i++) expect(tile[i], `${i}`).toBe(inside(i) && before[i] === 1 ? 0 : before[i]);
    });

    it('"any" emptying a tile deletes it without base and keeps it, all zeros, with base', () => {
      for (const base of [false, true]) {
        const { store, tile } = mixed(base);
        erase(store, { x0: 0, y0: 0, width: W, height: H }, 2, "any");
        if (base) { expect(store.tiles.get("0,0")).toBe(tile); expect(tile.every((v) => v === 0)).toBe(true); }
        else expect(store.tiles.has("0,0")).toBe(false);
      }
    });

    it('"any" still checks value is 1..255', () => {
      const { store } = mixed();
      expect(() => erase(store, win, 0, "any")).toThrow(/1\.\.255/);
    });
  });
}
