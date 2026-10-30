import { cellBuckets, PREVIEW_MAX_SIDE, previewCells, type MaskPreview } from "./maskPreview";
import type { Grid } from "./types";

/** A saved session's raster (spec 031): file size, grid and geotransform, so a renamed file matches and no other raster does. */
export const rasterKey = (size: number, g: Grid): string => JSON.stringify([size, g.width, g.height, g.epsg, ...g.gt]);

/** A 64-bit FNV-1a hash of a key as 16 hex digits: the mask copy's file name. */
export function keyHash(key: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < key.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(key.charCodeAt(i))) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0");
}

/** The keys in order, in lists of at most n. */
export function batches(keys: Iterable<string>, n: number): string[][] {
  const out: string[][] = [];
  for (const k of keys) {
    if (!out.length || out[out.length - 1]!.length >= n) out.push([]);
    out[out.length - 1]!.push(k);
  }
  return out;
}

/** Keys of the least recently saved sessions beyond the newest `limit`. */
export function evict(sessions: { key: string; savedAt: number }[], limit: number): string[] {
  return [...sessions].sort((a, b) => b.savedAt - a.savedAt).slice(limit).map((s) => s.key);
}

/** A saved mask preview's values on the grid's preview, with its corners and buckets computed again. */
export function restoredPreview(grid: Grid, values: Uint8Array): MaskPreview {
  const { cells, width, height, corners } = previewCells(grid, PREVIEW_MAX_SIDE);
  return { values, width, height, corners, buckets: cellBuckets(cells, grid) };
}
