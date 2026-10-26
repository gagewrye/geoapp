import { writeArrayBuffer } from "geotiff";
import type { GeoTags, RasterMeta, RasterSource } from "../../../src/io/source";
import type { Affine, Tile } from "../../../src/core/types";
import { makeTile } from "./tiles";

export type Value = (band: number, col: number, row: number) => number;

/** Synthetic source computing pixels on demand and logging every window read. */
export function fakeSource(meta: Partial<RasterMeta> & { width: number; height: number }, f: Value) {
  const reads: { x0: number; y0: number; width: number; height: number }[] = [];
  const full: RasterMeta = {
    bandCount: 3, gt: [500000, 30, 0, 5000000, 0, -30], epsg: 32633, nodata: null,
    geoTags: { GeoKeyDirectory: [1, 1, 0, 1, 3072, 0, 1, 32633], ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 500000, 5000000, 0] },
    ...meta,
  };
  const source: RasterSource = {
    meta: full,
    async readWindow(x0, y0, width, height): Promise<Tile> {
      reads.push({ x0, y0, width, height });
      return makeTile(x0, y0, width, height, full.bandCount, f, full.nodata);
    },
  };
  return { source, reads };
}

/** In-memory GeoTIFF (Float32, pixel-interleaved) written with geotiff.js for read-back tests. */
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
