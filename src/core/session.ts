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

/** Exported since its last change (spec 075): only such a session may be evicted or dropped. */
export const exportedSince = (s: { savedAt: number; exportedAt: number | null }): boolean => s.exportedAt !== null && s.exportedAt >= s.savedAt;

/** Ids to evict beyond the newest `limit` (spec 075 scope 4): only exported ones, oldest first; an unexported one is never evicted. */
export function evict(s: { id: string; savedAt: number; exportedAt: number | null }[], limit: number): string[] {
  const over = s.length - limit;
  if (over <= 0) return [];
  return s.filter(exportedSince).sort((a, b) => a.savedAt - b.savedAt).slice(0, over).map((x) => x.id);
}

/** One entry per raster for evict, with the raster as id: its newest savedAt, exported only when every session of it is (ADR 0042). */
export function byRaster(s: { raster: string; savedAt: number; exportedAt: number | null }[]): { id: string; savedAt: number; exportedAt: number | null }[] {
  const out = new Map<string, { id: string; savedAt: number; all: boolean }>();
  for (const x of s) {
    const r = out.get(x.raster) ?? { id: x.raster, savedAt: -Infinity, all: true };
    r.savedAt = Math.max(r.savedAt, x.savedAt);
    r.all &&= exportedSince(x);
    out.set(x.raster, r);
  }
  return [...out.values()].map(({ id, savedAt, all }) => ({ id, savedAt, exportedAt: all ? savedAt : null }));
}

/** Record indexes in offer order (spec 075): current sessions first, then replaced ones, each newest first. */
export function offers(records: { role: string; savedAt: number }[]): number[] {
  const rank = (r: { role: string }) => (r.role === "current" ? 0 : 1);
  return records.map((_, i) => i).sort((a, b) => rank(records[a]!) - rank(records[b]!) || records[b]!.savedAt - records[a]!.savedAt);
}

/** A new session id for a raster (ADR 0042): the raster key itself while no session uses it, else the key with the first free number. */
export function sessionId(raster: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(raster)) return raster;
  let n = 1;
  while (used.has(`${raster}#${n}`)) n++;
  return `${raster}#${n}`;
}

/** A saved mask preview's values on the grid's preview, with its corners and buckets computed again. */
export function restoredPreview(grid: Grid, values: Uint8Array): MaskPreview {
  const { cells, width, height, corners } = previewCells(grid, PREVIEW_MAX_SIDE);
  return { values, width, height, corners, buckets: cellBuckets(cells, grid) };
}
