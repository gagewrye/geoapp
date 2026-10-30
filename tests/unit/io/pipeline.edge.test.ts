import { describe, expect, it } from "vitest";
import { TILE_SIZE, type Affine, type Tile } from "../../../src/core/types";
import { buildPreview, openRaster, RasterRefusedError } from "../../../src/io/pipeline";
import type { RasterMeta, RasterSource } from "../../../src/io/source";

// Structural memory bounds and edge cases for criteria 8 and 16.

type Read = { x0: number; y0: number; width: number; height: number };

/** Cheap instrumented source: constant-per-window fill so very large rasters stay fast. */
function fastSource(meta: Partial<RasterMeta> & { width: number; height: number }, fill = (w: Read, k: number) => (w.x0 < meta.width / 2 ? 10 : 50) + k) {
  const reads: Read[] = [];
  const full: RasterMeta = {
    bandCount: 3, gt: [500000, 30, 0, 5000000, 0, -30], epsg: 32633, nodata: null, float: true, alpha: null,
    geoTags: { GeoKeyDirectory: [1, 1, 0, 1, 3072, 0, 1, 32633], ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 500000, 5000000, 0] },
    ...meta,
  };
  const source: RasterSource = {
    meta: full,
    async readWindow(x0, y0, width, height): Promise<Tile> {
      const w = { x0, y0, width, height };
      reads.push(w);
      const bands = Array.from({ length: full.bandCount }, (_, k) => new Float32Array(width * height).fill(fill(w, k)));
      return { x0, y0, width, height, bands, nodata: full.nodata };
    },
  };
  return { source, reads };
}

/** Every read is <= 256x256, aligned to the 256 grid, clipped to the raster. */
function expectGridReads(reads: Read[], width: number, height: number) {
  for (const w of reads) {
    expect(w.width).toBeGreaterThan(0);
    expect(w.height).toBeGreaterThan(0);
    expect(w.width).toBeLessThanOrEqual(TILE_SIZE);
    expect(w.height).toBeLessThanOrEqual(TILE_SIZE);
    expect(w.x0 % TILE_SIZE).toBe(0);
    expect(w.y0 % TILE_SIZE).toBe(0);
    expect(w.x0 + w.width).toBeLessThanOrEqual(width);
    expect(w.y0 + w.height).toBeLessThanOrEqual(height);
    expect(w.width === TILE_SIZE || w.x0 + w.width === width).toBe(true);
    expect(w.height === TILE_SIZE || w.y0 + w.height === height).toBe(true);
  }
}

const key = (w: Read) => `${w.x0},${w.y0}`;

describe("large rasters with partial edge tiles (criterion 8)", () => {
  // Generous timeout: a synthetic 8192 px source read in 1024 windows is slow under full-suite parallel load.
  it("builds the preview of an 8192x8192 raster from grid windows only, never the full raster", async () => {
    const { source, reads } = fastSource({ width: 8192, height: 8192 });
    const p = await buildPreview(source, 1024);
    expectGridReads(reads, 8192, 8192);
    expect(new Set(reads.map(key)).size).toBe(reads.length);
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1024);
  }, 30_000);
});

describe("EPSG:3857 boundary at 180 degrees (criterion 16)", () => {
  const HALF = Math.PI * 6378137;
  const open = async (gt: Affine, w: number) => {
    const { source, reads } = fastSource({ width: w, height: 10, epsg: 3857, gt });
    const result = await openRaster(source).then(() => "open", (e) => (e instanceof RasterRefusedError ? e.reason : String(e)));
    expect(reads).toHaveLength(0);
    return result;
  };

  it("opens rasters whose east or west edge is exactly at 180", async () => {
    expect(await open([HALF - 1000 * 100, 100, 0, 0, 0, -100], 1000)).toBe("open");
    expect(await open([-HALF, 100, 0, 0, 0, -100], 1000)).toBe("open");
  });

  it("refuses rasters past 180 by one metre either way without reading", async () => {
    expect(await open([HALF - 1000 * 100 + 1, 100, 0, 0, 0, -100], 1000)).toBe("antimeridian");
    expect(await open([-HALF - 1, 100, 0, 0, 0, -100], 1000)).toBe("antimeridian");
  });

  it("refuses an EPSG:4326 raster whose west edge is past -180 and one rotated past 180 by its row term", async () => {
    const g = async (gt: Affine) => {
      const { source, reads } = fastSource({ width: 100, height: 100, epsg: 4326, gt });
      await expect(openRaster(source)).rejects.toSatisfy((e: unknown) => e instanceof RasterRefusedError && e.reason === "antimeridian");
      expect(reads).toHaveLength(0);
    };
    await g([-180.01, 0.01, 0, 10, 0, -0.01]);
    await g([179, 0.01, 0.005, 10, 0, -0.01]); // bottom-right corner reaches 179 + 1 + 0.5
  });
});
