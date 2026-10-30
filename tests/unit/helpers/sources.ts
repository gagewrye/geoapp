import { writeArrayBuffer } from "geotiff";
import type { Block } from "../../../src/core/imagery";
import type { GeoTags, ImagerySource, RasterMeta, RasterSource } from "../../../src/io/source";
import type { Affine, Tile } from "../../../src/core/types";
import { makeTile } from "./tiles";

export type Value = (band: number, col: number, row: number) => number;

/** Synthetic source computing pixels on demand and logging every window read; float by default, as its tiles are Float32 and may hold NaN. */
export function fakeSource(meta: Partial<RasterMeta> & { width: number; height: number }, f: Value) {
  const reads: { x0: number; y0: number; width: number; height: number }[] = [];
  const full: RasterMeta = {
    bandCount: 3, gt: [500000, 30, 0, 5000000, 0, -30], epsg: 32633, nodata: null, float: true, alpha: null,
    geoTags: { GeoKeyDirectory: [1, 1, 0, 1, 3072, 0, 1, 32633], ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 500000, 5000000, 0] },
    ...meta,
  };
  const source: RasterSource = {
    meta: full,
    async readWindow(x0, y0, width, height): Promise<Tile> {
      reads.push({ x0, y0, width, height });
      return { ...makeTile(x0, y0, width, height, full.bandCount, f, full.nodata), alpha: full.alpha };
    },
  };
  return { source, reads };
}

export type SampleRead = { image: number; x0: number; y0: number; width: number; height: number; bands: number[] };

/** fakeSource plus spec 020's block, no overviews, and readSamples logging each read (readWindow throws unless allowed). */
export function samplesSource(meta: Partial<RasterMeta> & { width: number; height: number }, f: Value, block: Block, allowWindows = false) {
  const { source: inner, reads: windowReads } = fakeSource(meta, f);
  const reads: SampleRead[] = [];
  const source: ImagerySource = {
    meta: inner.meta, block, overviews: [],
    readWindow: (x0, y0, w, h) => { if (!allowWindows) throw new Error("readWindow"); return inner.readWindow(x0, y0, w, h); },
    async readSamples(image, x0, y0, width, height, bands) {
      reads.push({ image, x0, y0, width, height, bands: [...bands] });
      return bands.map((k) => Float32Array.from({ length: width * height }, (_, p) => f(k, x0 + (p % width), y0 + Math.floor(p / width))));
    },
  };
  return { source, reads, windowReads };
}

/** In-memory GeoTIFF (Float32, pixel-interleaved) written with geotiff.js for read-back tests; its ExtraSamples is geotiff.js's default 0 (no alpha). */
export function geotiffBuffer(width: number, height: number, nb: number, f: Value, geo: { epsg: number; gt: Affine; nodata?: string }): ArrayBuffer {
  const vals = new Float32Array(width * height * nb);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) for (let b = 0; b < nb; b++) vals[(r * width + c) * nb + b] = f(b, c, r);
  const [a, sx, , d, , sy] = geo.gt;
  const keys = geo.epsg === 4326
    ? { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 }
    : { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: geo.epsg };
  return writeArrayBuffer(vals, {
    width, height, SamplesPerPixel: nb, ModelPixelScale: [sx, -sy, 0], ModelTiepoint: [0, 0, 0, a, d, 0],
    GTRasterTypeGeoKey: 1, ...keys, ...(geo.nodata ? { GDAL_NODATA: geo.nodata } : {}),
  });
}

export function recordingSink() {
  const writes: Uint8Array[] = [];
  let closed = false;
  return {
    writes,
    get closed() { return closed; },
    sink: { async write(d: Uint8Array) { writes.push(d.slice()); }, async close() { closed = true; } },
    bytes(): Uint8Array {
      const out = new Uint8Array(writes.reduce((s, w) => s + w.length, 0));
      let o = 0;
      for (const w of writes) { out.set(w, o); o += w.length; }
      return out;
    },
  };
}

export type { GeoTags };
