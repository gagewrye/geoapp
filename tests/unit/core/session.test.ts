import { describe, expect, it } from "vitest";
import { batches, byRaster, evict, keyHash, offers, rasterKey, restoredPreview, sessionId } from "../../../src/core/session";
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

// Spec 075 criterion 1.
describe("evict", () => {
  const raster = (i: number, exported: boolean | "stale") =>
    ({ id: `r${i}`, savedAt: 100 + i, exportedAt: exported === true ? 100 + i : exported === "stale" ? 99 + i : null });

  it("gives the least recently saved exported ids beyond the limit", () => {
    const s = [{ id: "a", savedAt: 5, exportedAt: 6 }, { id: "b", savedAt: 1, exportedAt: 1 }, { id: "c", savedAt: 9, exportedAt: 9 }, { id: "d", savedAt: 3, exportedAt: 4 }];
    expect(evict(s, 2)).toEqual(["b", "d"]);
    expect(evict(s, 3)).toEqual(["b"]);
    expect(evict(s, 8)).toEqual([]);
  });

  it("never returns an unexported id, or one changed since its export", () => {
    for (let n = 0; n < 64; n++) {
      const s = Array.from({ length: 12 }, (_, i) => raster(i, (n >> (i % 6)) & 1 ? true : i % 2 ? "stale" : false));
      for (const id of evict(s, 8)) {
        const x = s.find((r) => r.id === id)!;
        expect(x.exportedAt !== null && x.exportedAt >= x.savedAt).toBe(true);
      }
    }
  });

  it("with 10 rasters all unexported returns []; with 3 of 10 exported returns the 2 oldest exported", () => {
    expect(evict(Array.from({ length: 10 }, (_, i) => raster(i, false)), 8)).toEqual([]);
    const s = Array.from({ length: 10 }, (_, i) => raster(i, i === 2 || i === 5 || i === 8));
    expect(evict(s, 8)).toEqual(["r2", "r5"]);
    expect(evict(Array.from({ length: 10 }, (_, i) => raster(i, i === 7)), 8)).toEqual(["r7"]); // too few to evict: everything else is kept
  });
});

describe("byRaster", () => {
  it("one entry per raster, its newest save, exported only when every session of it is", () => {
    const s = [
      { raster: "a", savedAt: 5, exportedAt: 5 }, { raster: "a", savedAt: 9, exportedAt: null },
      { raster: "b", savedAt: 3, exportedAt: 4 }, { raster: "b", savedAt: 7, exportedAt: 7 },
    ];
    expect(byRaster(s)).toEqual([{ id: "a", savedAt: 9, exportedAt: null }, { id: "b", savedAt: 7, exportedAt: 7 }]);
  });
});

describe("offers", () => {
  it("lists current sessions first, then replaced ones, each newest first", () => {
    expect(offers([])).toEqual([]);
    expect(offers([{ role: "replaced", savedAt: 9 }, { role: "current", savedAt: 1 }])).toEqual([1, 0]);
    expect(offers([{ role: "current", savedAt: 1 }, { role: "replaced", savedAt: 2 }, { role: "current", savedAt: 5 }, { role: "replaced", savedAt: 8 }])).toEqual([2, 0, 3, 1]);
  });
});

describe("sessionId", () => {
  it("is the raster key while free, then the first free numbered key", () => {
    expect(sessionId("k", [])).toBe("k");
    expect(sessionId("k", ["k"])).toBe("k#1");
    expect(sessionId("k", ["k", "k#1", "k#3"])).toBe("k#2");
  });
});

describe("restoredPreview", () => {
  it("rebuilds the mask preview's size, corners and buckets from the grid", { timeout: 30_000 }, () => {
    const { cells, width, height, corners } = previewCells(G, PREVIEW_MAX_SIDE);
    const values = new Uint8Array(width * height).fill(2);
    const p = restoredPreview(G, values);
    expect(p).toEqual({ values, width, height, corners, buckets: cellBuckets(cells, G) });
  });
});
