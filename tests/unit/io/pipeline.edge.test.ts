import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { brush, emptyStore } from "../../../src/core/labelStore";
import { predictTile } from "../../../src/core/predict";
import { TILE_SIZE, type Affine, type Model, type Tile } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { buildPreview, classify, openRaster, RasterRefusedError, train } from "../../../src/io/pipeline";
import type { RasterMeta, RasterSource } from "../../../src/io/source";
import { geotiffBuffer, recordingSink } from "../helpers/sources";

// Structural memory bounds and edge cases for criteria 8, 9 and 16.

type Read = { x0: number; y0: number; width: number; height: number };

/** Cheap instrumented source: constant-per-window fill so very large rasters stay fast. */
function fastSource(meta: Partial<RasterMeta> & { width: number; height: number }, fill = (w: Read, k: number) => (w.x0 < meta.width / 2 ? 10 : 50) + k) {
  const reads: Read[] = [];
  const full: RasterMeta = {
    bandCount: 3, gt: [500000, 30, 0, 5000000, 0, -30], epsg: 32633, nodata: null,
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
const model1: Model = { version: 1, type: "logreg", bands: [1], mean: [30], std: [20], classes: ["low", "high"], W: [[-1], [1]], b: [0, 0] };

/** Paint [c0, r0, c1, r1) clipped to the raster, with all-valid masks. */
function paint(store: ReturnType<typeof emptyStore>, [c0, r0, c1, r1]: number[], value: number) {
  const x0 = Math.max(0, c0!), y0 = Math.max(0, r0!);
  const w = { x0, y0, width: Math.min(store.width, c1!) - x0, height: Math.min(store.height, r1!) - y0 };
  const masks = new Map<string, Uint8Array>();
  for (let y = 0; y < store.height; y += TILE_SIZE) for (let x = 0; x < store.width; x += TILE_SIZE) masks.set(`${x},${y}`, new Uint8Array(8192));
  brush(store, masks, w, value, false);
}

describe("large rasters with partial edge tiles (criterion 8)", () => {
  it("classifies a 5000x3000 raster reading each grid window exactly once, writing only 64 KiB tiles", async () => {
    const W = 5000, H = 3000;
    const { source, reads } = fastSource({ width: W, height: H });
    const rec = recordingSink();
    await classify(source, model1, rec.sink);
    const tiles = Math.ceil(W / 256) * Math.ceil(H / 256);
    expectGridReads(reads, W, H);
    expect(reads).toHaveLength(tiles);
    expect(new Set(reads.map(key)).size).toBe(tiles);
    expect(rec.writes).toHaveLength(1 + tiles);
    expect(rec.writes.slice(1).every((w) => w.length <= 65536)).toBe(true);
    expect(rec.closed).toBe(true);
  });

  // Generous timeout: a synthetic 8192 px source read in 1024 windows is slow under full-suite parallel load.
  it("builds the preview of an 8192x8192 raster from grid windows only, never the full raster", async () => {
    const { source, reads } = fastSource({ width: 8192, height: 8192 });
    const p = await buildPreview(source, 1024);
    expectGridReads(reads, 8192, 8192);
    expect(new Set(reads.map(key)).size).toBe(reads.length);
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1024);
  }, 30_000);

  it("trains on labels in partial edge tiles reading only those clipped windows", async () => {
    const W = 1000, H = 700;
    const { source, reads } = fastSource({ width: W, height: H });
    const store = emptyStore(W, H);
    paint(store, [900, 600, 1200, 900], 2);
    paint(store, [-100, -50, 30, 20], 1);
    const r = await train(source, store, ["a", "b"], { epochs: 5 });
    expectGridReads(reads, W, H);
    expect(reads.map(key).sort()).toEqual(["0,0", "768,512"]);
    expect(r !== "no samples" && r.samples).toBe(100 * 100 + 30 * 20);
  });

  it("returns \"no samples\" when every labelled pixel is nodata, reading only the stored tiles", async () => {
    const { source, reads } = fastSource({ width: 1000, height: 700, nodata: 10 }); // the west half is nodata
    const store = emptyStore(1000, 700);
    paint(store, [0, 0, 20, 20], 1);
    paint(store, [300, 300, 320, 320], 2);
    expect(await train(source, store, ["a", "b"])).toBe("no samples");
    expect(reads.map(key).sort()).toEqual(["0,0", "256,256"]);
  });

  it("reads nothing with an empty store", async () => {
    const { source, reads } = fastSource({ width: 1000, height: 700 });
    expect(await train(source, emptyStore(1000, 700), ["a", "b"])).toBe("no samples");
    expect(reads).toHaveLength(0);
  });

  it("rejects a model whose bands exceed the raster's band count before any read or write", async () => {
    const { source, reads } = fastSource({ width: 600, height: 600, bandCount: 2 });
    const rec = recordingSink();
    await expect(classify(source, { ...model1, bands: [3] }, rec.sink)).rejects.toThrow(/bands/);
    expect(reads).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
  });

  it("rejects a raster just over the classic TIFF limit before any read or write, and accepts one under it", async () => {
    // 65536x65536 at 64 KiB per tile = exactly 2^32 bytes of tiles, over the 2^32-1 limit
    const big = fastSource({ width: 65536, height: 65536 });
    const rec = recordingSink();
    await expect(classify(big.source, model1, rec.sink)).rejects.toThrow(/too large/);
    expect(big.reads).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
  });
});

describe("export read-back edge cases (criterion 9)", () => {
  it("round-trips an EPSG:4326 raster spanning several partial tiles, with nodata on a non-model band", async () => {
    const gt: Affine = [12.5, 0.0025, 0, 47.25, 0, -0.0025];
    const f = (b: number, c: number, r: number) => (b === 1 && (c + r) % 9 === 0 ? -9999 : b === 0 ? Math.sin(c / 40) * 100 + r * 0.1 : (c * r) % 17);
    const buf = geotiffBuffer(600, 300, 2, f, { epsg: 4326, gt, nodata: "-9999" });
    const input = await (await fromArrayBuffer(buf)).getImage();
    const source = await openGeoTiff(await fromArrayBuffer(buf));
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [50], classes: ["lo", "mid", "hi"], W: [[-2], [0], [2]], b: [0, 1, 0] };
    const rec = recordingSink();
    await classify(source, model, rec.sink);
    const out = await (await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer)).getImage();
    expect([out.getWidth(), out.getHeight(), out.getTileWidth(), out.getTileHeight()]).toEqual([600, 300, 256, 256]);
    expect(out.getOrigin()).toEqual(input.getOrigin());
    expect(out.getResolution()).toEqual(input.getResolution());
    expect(out.getGeoKeys()).toEqual(input.getGeoKeys());
    expect(out.getGDALNoData()).toBe(255);
    const [px] = (await out.readRasters()) as unknown as Uint8Array[];
    const expected = predictTile(model, await source.readWindow(0, 0, 600, 300));
    expect(new Set(expected).size).toBe(3);
    expect(Array.from(px!)).toEqual(Array.from(expected));
    expect(px!.includes(255)).toBe(false); // band 2 nodata must not leak into a band-1 model
  });
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
