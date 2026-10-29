import { describe, expect, it } from "vitest";
import { emptyStore, MAX_LABEL_TILES, putTile } from "../../../src/core/labelStore";

// Spec 004 criterion 8 (putTile).

const win = (x0: number, y0: number, width = 256, height = 256) => ({ x0, y0, width, height });

describe("putTile (criterion 8)", () => {
  it("replaces a tile and deletes it when given all zeros", () => {
    const store = emptyStore(300, 300);
    const a = new Uint8Array(44 * 256).fill(1);
    expect(putTile(store, win(256, 0, 44, 256), a)).toBe("ok");
    expect(store.tiles.get("256,0")).toBe(a);
    const b = new Uint8Array(44 * 256);
    b[5] = 3;
    expect(putTile(store, win(256, 0, 44, 256), b)).toBe("ok");
    expect(store.tiles.get("256,0")).toBe(b);
    expect(putTile(store, win(256, 0, 44, 256), new Uint8Array(44 * 256))).toBe("ok");
    expect(store.tiles.size).toBe(0);
    // all zeros for a tile that isn't stored stores nothing
    expect(putTile(store, win(0, 0), new Uint8Array(256 * 256))).toBe("ok");
    expect(store.tiles.size).toBe(0);
  });

  it("at MAX_LABEL_TILES returns \"full\" for a new key, changing nothing, but still replaces an existing key", () => {
    const store = emptyStore(256 * 17, 256 * 17);
    for (let i = 0; i < MAX_LABEL_TILES; i++) putTile(store, win((i % 17) * 256, Math.floor(i / 17) * 256), new Uint8Array(65536).fill(1));
    expect(store.tiles.size).toBe(MAX_LABEL_TILES);
    const before = new Map(store.tiles);
    const fresh = win(16 * 256, 16 * 256);
    expect(store.tiles.has("4096,4096")).toBe(false);
    expect(putTile(store, fresh, new Uint8Array(65536).fill(2))).toBe("full");
    expect(store.tiles.size).toBe(MAX_LABEL_TILES);
    expect([...store.tiles].every(([k, v]) => before.get(k) === v && v[0] === 1)).toBe(true);
    const t = new Uint8Array(65536).fill(4);
    expect(putTile(store, win(0, 0), t)).toBe("ok");
    expect(store.tiles.get("0,0")).toBe(t);
    // deleting at the cap still works, and then a new key fits
    expect(putTile(store, win(256, 0), new Uint8Array(65536))).toBe("ok");
    expect(putTile(store, fresh, new Uint8Array(65536).fill(2))).toBe("ok");
    expect(store.tiles.size).toBe(MAX_LABEL_TILES);
  });

  it("throws on labels that aren't window-sized", () => {
    expect(() => putTile(emptyStore(300, 300), win(0, 0), new Uint8Array(10))).toThrow(/putTile/);
  });
});
