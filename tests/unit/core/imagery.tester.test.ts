import { describe, expect, it } from "vitest";
import { applyAffine, fromLonLat, invertAffine, toLonLat } from "../../../src/core/crs";
import { blockWindows, IMAGERY_TILES, imageryQuads, MAX_READ_BYTES, planView, rowReads, toRgba } from "../../../src/core/imagery";
import type { Window } from "../../../src/core/grid";
import { QUAD_ERR, tileQuads } from "../../../src/core/labelQuads";
import { tileWindow } from "../../../src/core/labelStore";
import type { Affine, Grid } from "../../../src/core/types";
import { warpPreview } from "../../../src/core/warp";

// Spec 020, tester: rotated and 45N grids, raster edges and partial tiles, degenerate inputs.

/** A UTM 18N grid at 45N, 400 km easting (off the central meridian), rotated by `deg` degrees, 0.5 m pixels. */
function rotatedUtm(deg: number, width = 3000, height = 2200): Grid {
  const t = (deg * Math.PI) / 180, p = 0.5;
  const [x, y] = fromLonLat(32618, -76.3, 45);
  const gt: Affine = [x, p * Math.cos(t), p * Math.sin(t), y, p * Math.sin(t), -p * Math.cos(t)];
  return { epsg: 32618, gt, width, height };
}

/** Lon/lat bounds [w, s, e, n] of a cssW x cssH view centred on raster pixel (c, r) with about d source pixels per CSS pixel. */
function viewAround(g: Grid, c: number, r: number, d: number, cssW: number, cssH: number): [number, number, number, number] {
  const [lon, lat] = toLonLat(g.epsg, ...applyAffine(g.gt, c, r));
  const m = Math.hypot(g.gt[1], g.gt[4]) * d; // metres per CSS pixel
  const halfLon = (m * cssW) / 2 / (111320 * Math.cos((lat * Math.PI) / 180)), halfLat = (m * cssH) / 2 / 111320;
  return [lon - halfLon, lat - halfLat, lon + halfLon, lat + halfLat];
}

const inside = (t: Window, x: number, y: number) => x >= t.x0 && x < t.x0 + t.width && y >= t.y0 && y < t.y0 + t.height;

describe("planView on a rotated UTM grid at 45N", () => {
  const g = rotatedUtm(25);

  it("gives s = 1 tiles that are exactly the label tiles (same windows, same quads), including the clipped edge tiles", () => {
    // centred near the bottom right corner, so edge tiles are partial in both axes
    const p = planView(g, [], viewAround(g, 2900, 2100, 0.6, 1000, 700), 1000, 700)!;
    expect(p.level.s).toBe(1);
    expect(p.level.grid).toEqual(g);
    const partial = p.tiles.filter((t) => t.width < 256 || t.height < 256);
    expect(partial.length).toBeGreaterThan(0);
    for (const t of p.tiles) {
      expect(t).toEqual(tileWindow(g, t.x0, t.y0));
      expect(imageryQuads(p.level, t)).toEqual(tileQuads(g, t, QUAD_ERR));
    }
  });

  it("covers every raster pixel in the view, rotated, and never more than IMAGERY_TILES / 2 tiles", () => {
    for (const [c, r, d] of [[1500, 1100, 1], [10, 10, 0.8], [1500, 1100, 3]] as const) {
      const bounds = viewAround(g, c, r, d, 1200, 800);
      const p = planView(g, [], bounds, 1200, 800)!;
      expect(p.tiles.length).toBeLessThanOrEqual(IMAGERY_TILES / 2);
      const s = p.level.s;
      let checked = 0;
      for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
        const lon = bounds[0] + ((bounds[2] - bounds[0]) * i) / 40, lat = bounds[1] + ((bounds[3] - bounds[1]) * j) / 40;
        const [x, y] = invertAffine(g.gt, ...fromLonLat(g.epsg, lon, lat));
        if (x < 0 || y < 0 || x >= g.width || y >= g.height) continue;
        checked++;
        expect(p.tiles.some((t) => inside(t, Math.floor(x / s), Math.floor(y / s))), `pixel ${x},${y} at s=${s}`).toBe(true);
      }
      expect(checked).toBeGreaterThan(50);
    }
  });
});

describe("planView edges", () => {
  const G: Grid = { epsg: 4326, gt: [10, 1e-4, 0, 45.1, 0, -1e-4], width: 1, height: 1 };

  it("a 1 x 1 raster gives one 1 x 1 tile at s = 1", () => {
    const p = planView(G, [], [9.9999, 45.0998, 10.0002, 45.1001], 300, 300)!;
    expect(p.tiles).toEqual([{ x0: 0, y0: 0, width: 1, height: 1 }]);
  });

  it("an exact power of two in density doesn't round down a level, and just under it does", () => {
    const g: Grid = { epsg: 4326, gt: [10, 1e-4, 0, 1, 0, -1e-4], width: 40000, height: 40000 };
    const at = (d: number) => planView(g, [], [12 - (d * 500 * 1e-4) / 2, -1 - (d * 400 * 1e-4) / 2, 12 + (d * 500 * 1e-4) / 2, -1 + (d * 400 * 1e-4) / 2], 500, 400)!.level.s;
    expect(at(4)).toBe(4);
    expect(at(3.99)).toBe(2);
  });

  it("a view of zero CSS size gives null, not a plan", () => {
    expect(planView(G, [], [9, 45, 11, 46], 0, 0)).toBeNull();
  });
});

describe("toRgba edge cases", () => {
  it("NaN or nodata in any one band hides the pixel", () => {
    const out = new Uint8ClampedArray(12);
    toRgba([Float32Array.of(1, 1, 1), Float32Array.of(1, NaN, 1), Float32Array.of(1, 1, -5)], 3, [[0, 2], [0, 2], [0, 2]], -5, out);
    expect([out[3], out[7], out[11]]).toEqual([255, 0, 0]);
  });

  it("a constant band (one-class raster) maps to 0 like warpPreview, and only the first n pixels are written", () => {
    const bands = [Float32Array.from({ length: 16 }, () => 7)];
    const pv = warpPreview({ x0: 0, y0: 0, width: 4, height: 4, bands, nodata: null }, [0, 0.001, 0, 0.004, 0, -0.001], 4326, 4);
    const out = new Uint8ClampedArray(64).fill(9);
    toRgba(bands, 3, pv.ranges, null, out);
    expect(Array.from(out.slice(0, 12))).toEqual(Array.from(pv.rgba.slice(0, 12)));
    expect(Array.from(out.slice(12))).toEqual(Array(52).fill(9));
  });

  it("two bands show band 0 as grey, as the preview does", () => {
    const out = new Uint8ClampedArray(4);
    toRgba([Uint8Array.of(100), Uint8Array.of(250)], 1, [[0, 200]], null, out);
    expect(Array.from(out)).toEqual([128, 128, 128, 255]);
  });

  it("signed raw values below the range clamp to 0", () => {
    const out = new Uint8ClampedArray(8);
    toRgba([Int16Array.of(-300, 300)], 2, [[-100, 100]], null, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe("rowReads edge cases", () => {
  const tile = (x0: number, y0: number, width = 256, height = 256): Window => ({ x0, y0, width, height });

  it("no tiles give no reads; input order doesn't matter; different rows never merge", () => {
    expect(rowReads([], 1, 3)).toEqual([]);
    const a = rowReads([tile(256, 0), tile(0, 256), tile(0, 0)], 1, 3);
    expect(a).toEqual([{ x0: 0, y0: 0, width: 512, height: 256 }, { x0: 0, y0: 256, width: 256, height: 256 }]);
  });

  it("splits exactly at the limit: two s = 4 Float32 one-band tiles fit, a third doesn't", () => {
    // one tile at s = 4: 1024 x 1024 x 4 B = 4 MiB; 8 fit in 32 MiB
    const row = Array.from({ length: 9 }, (_, i) => tile(i * 256, 0));
    const reads = rowReads(row, 4, 4);
    expect(reads.map((r) => r.width / 1024)).toEqual([8, 1]);
    for (const r of reads) expect(r.width * r.height * 4).toBeLessThanOrEqual(MAX_READ_BYTES);
  });

  it("a partial last tile reads its texels' full spans, which the loader then clips to the image", () => {
    expect(rowReads([tile(256, 0, 2, 256)], 4, 1)).toEqual([{ x0: 1024, y0: 0, width: 8, height: 1024 }]);
  });
});

describe("blockWindows edge cases", () => {
  it("a 1 x 1 image and a step larger than the image read one pixel", () => {
    expect(blockWindows(1, 1, 256, 256, 1)).toEqual([{ x0: 0, y0: 0, width: 1, height: 1 }]);
    // f = 50 on 30 px samples pixel floor(50/2) clamped to 29
    expect(blockWindows(30, 20, 256, 256, 50)).toEqual([{ x0: 25, y0: 19, width: 1, height: 1 }]);
  });
});
