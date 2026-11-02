import { describe, expect, it } from "vitest";
import { brush, emptyStore, putTile, type NodataMasks } from "../../../src/core/labelStore";

// Spec 014 criterion 3: with a mask loaded (base: true), emptied and all-zero tiles are kept, since they hide the mask.
// With base false, spec 003 criterion 4 and spec 004 criterion 8 hold unchanged (labelStore.test.ts, labelStore.put.test.ts).

const win = (x0: number, y0: number, width = 256, height = 256) => ({ x0, y0, width, height });
const noMasks: NodataMasks = new Map();

describe("the base flag (criterion 3)", () => {
  it("emptyStore gives base false", () => {
    expect(emptyStore(10, 10).base).toBe(false);
  });

  it("with base, an erase that empties a tile keeps it, all zeros", () => {
    const store = { ...emptyStore(300, 300), base: true };
    const t = new Uint8Array(65536);
    t[0] = 2; t[300] = 2;
    store.tiles.set("0,0", t);
    brush(store, noMasks, win(0, 0, 50, 50), 2, true);
    expect(store.tiles.get("0,0")).toBe(t);
    expect(t.every((v) => v === 0)).toBe(true);
  });

  it("with base, putTile of zeros keeps the tile (stores it, even when new)", () => {
    const store = { ...emptyStore(300, 300), base: true };
    const zeros = new Uint8Array(65536);
    putTile(store, win(0, 0), zeros);
    expect(store.tiles.get("0,0")).toBe(zeros);
    store.tiles.set("256,0", new Uint8Array(44 * 256).fill(1));
    const z2 = new Uint8Array(44 * 256);
    putTile(store, win(256, 0, 44, 256), z2);
    expect(store.tiles.get("256,0")).toBe(z2);
  });

  it("without base, the same erase and putTile delete the tile", () => {
    const store = emptyStore(300, 300);
    store.tiles.set("0,0", new Uint8Array(65536).fill(0).map((_, i) => (i === 0 ? 2 : 0)));
    brush(store, noMasks, win(0, 0, 5, 5), 2, true);
    expect(store.tiles.size).toBe(0);
    store.tiles.set("0,0", new Uint8Array(65536).fill(1));
    putTile(store, win(0, 0), new Uint8Array(65536));
    expect(store.tiles.size).toBe(0);
  });
});
