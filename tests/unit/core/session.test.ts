import { describe, expect, it } from "vitest";
import { batches, evict, keyHash, rasterKey, restoredPreview } from "../../../src/core/session";
import { cellBuckets, PREVIEW_MAX_SIDE, previewCells } from "../../../src/core/maskPreview";
import type { Grid } from "../../../src/core/types";

// Spec 031 criterion 1.
const G: Grid = { width: 1000, height: 700, epsg: 32633, gt: [500000, 0.1, 0, 4000000, 0, -0.1] };

describe("rasterKey", () => {
  it("is equal for equal inputs and differs when the size, width, height, EPSG or any geotransform term differs", () => {
    const k = rasterKey(123456, G);
    expect(rasterKey(123456, { ...G, gt: [...G.gt] })).toBe(k);
    const others = [
      rasterKey(123457, G),
      rasterKey(123456, { ...G, width: 1001 }),
      rasterKey(123456, { ...G, height: 701 }),
      rasterKey(123456, { ...G, epsg: 32634 }),
      ...G.gt.map((_, i) => rasterKey(123456, { ...G, gt: G.gt.map((v, j) => (j === i ? v + 1e-9 : v)) as Grid["gt"] })),
    ];
    expect(new Set([k, ...others]).size).toBe(others.length + 1);
  });

  it("keyHash is stable, file-name safe and differs between keys", () => {
    const a = rasterKey(1, G), b = rasterKey(2, G);
    expect(keyHash(a)).toBe(keyHash(a));
    expect(keyHash(a)).not.toBe(keyHash(b));
    expect(keyHash(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("batches", () => {
  it("splits keys in order into lists of at most n", () => {
    expect(batches(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(batches(new Set(["a"]), 16)).toEqual([["a"]]);
    expect(batches([], 16)).toEqual([]);
  });
});

describe("evict", () => {
  it("gives the least recently saved keys beyond the limit", () => {
    const s = [{ key: "a", savedAt: 5 }, { key: "b", savedAt: 1 }, { key: "c", savedAt: 9 }, { key: "d", savedAt: 3 }];
    expect(evict(s, 2).sort()).toEqual(["b", "d"]);
    expect(evict(s, 3)).toEqual(["b"]);
    expect(evict(s, 8)).toEqual([]);
  });
});

describe("restoredPreview", () => {
  it("rebuilds the mask preview's size, corners and buckets from the grid", () => {
    const { cells, width, height, corners } = previewCells(G, PREVIEW_MAX_SIDE);
    const values = new Uint8Array(width * height).fill(2);
    const p = restoredPreview(G, values);
    expect(p).toEqual({ values, width, height, corners, buckets: cellBuckets(cells, G) });
  });
});
