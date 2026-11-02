import { describe, expect, it } from "vitest";
import { emptyStore, putTile } from "../../../src/core/labelStore";

// Spec 004 criterion 8 (putTile).

const win = (x0: number, y0: number, width = 256, height = 256) => ({ x0, y0, width, height });

describe("putTile (criterion 8)", () => {
  it("replaces a tile and deletes it when given all zeros", () => {
    const store = emptyStore(300, 300);
    const a = new Uint8Array(44 * 256).fill(1);
    putTile(store, win(256, 0, 44, 256), a);
    expect(store.tiles.get("256,0")).toBe(a);
    const b = new Uint8Array(44 * 256);
    b[5] = 3;
    putTile(store, win(256, 0, 44, 256), b);
    expect(store.tiles.get("256,0")).toBe(b);
    putTile(store, win(256, 0, 44, 256), new Uint8Array(44 * 256));
    expect(store.tiles.size).toBe(0);
    // all zeros for a tile that isn't stored stores nothing
    putTile(store, win(0, 0), new Uint8Array(256 * 256));
    expect(store.tiles.size).toBe(0);
  });

  it("throws on labels that aren't window-sized", () => {
    expect(() => putTile(emptyStore(300, 300), win(0, 0), new Uint8Array(10))).toThrow(/putTile/);
  });
});
