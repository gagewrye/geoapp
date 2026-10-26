import type { Affine, Tile } from "./types";

/** AlphaEarth Foundations annual embeddings (spec 002, ADR 0005). */
export const AEF_RES = 10; // m
export const MAX_AOI_SIDE = 2048; // px
export const AEF_BANDS = 64;
export const AEF_NODATA_Q = -128;

/** One COG of the index. Bounds are UTM metres: x0 = west, y0 = south, x1 = east, y1 = north. */
export type AefEntry = { year: number; epsg: number; path: string; x0: number; y0: number; x1: number; y1: number };

/** North-up (gt[5] < 0) 10 m grid in one UTM zone. */
export type Aoi = { epsg: number; gt: Affine; width: number; height: number };

/** sign(q) * (q / 127.5)^2, the AEF Int8 encoding; -128 (no data) becomes NaN. */
export function dequantize(q: Int8Array, out: Float32Array): void {
  if (q.length !== out.length) throw new Error(`dequantize: ${q.length} values into ${out.length}`);
  for (let i = 0; i < q.length; i++) {
    const v = q[i]!;
    out[i] = v === AEF_NODATA_Q ? NaN : (v * Math.abs(v)) / (127.5 * 127.5);
  }
}

/** Preview value for NaN pixels; 0..255 are all real values. */
export const AEF_PREVIEW_NODATA = -1;
const PREVIEW_BANDS = [1, 16, 9]; // A01, A16, A09 as R, G, B
const LO = -0.3, HI = 0.3;

/** False-colour preview: A01, A16, A09 stretched linearly from [-0.3, 0.3] to [0, 255], clamped. */
export function aefPreview(tile: Tile): Tile {
  const n = tile.width * tile.height;
  const bands = PREVIEW_BANDS.map((b) => {
    const src = tile.bands[b]!;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = src[i]!;
      out[i] = Number.isNaN(v) ? AEF_PREVIEW_NODATA : Math.min(255, Math.max(0, Math.round(((v - LO) / (HI - LO)) * 255)));
    }
    return out;
  });
  return { x0: tile.x0, y0: tile.y0, width: tile.width, height: tile.height, bands, nodata: AEF_PREVIEW_NODATA };
}
