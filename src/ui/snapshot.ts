import type { LabelSource } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import { batches, evict, restoredPreview } from "../core/session";
import type { Grid } from "../core/types";
import type { SessionRecord, SessionStore } from "../io/session";

/** Tiles per IndexedDB transaction (about 1 MiB), and per read on restore (spec 031). */
export const TILE_BATCH = 16;
/** Sessions kept; the least recently saved goes first, with its mask copy. */
export const MAX_SESSIONS = 8;

/** One raster's changes, copied when a save starts (spec 031): tiles (null for a deleted one), the record, a replace's clear and mask file. */
export type Snapshot = {
  key: string;
  tiles: [string, ArrayBuffer | null][];
  clear: boolean;
  file: Blob | null;
  record: Omit<SessionRecord, "savedAt">;
  /** Labels existed when copied; with none, a saved session is deleted instead. */
  labelled: boolean;
};

/** a then b, as one snapshot: b's tiles and record win, and b's clear drops a's tiles. */
export function mergeSnapshots(a: Snapshot, b: Snapshot): Snapshot {
  if (b.clear) return { ...b, file: b.file ?? a.file };
  const tiles = new Map(a.tiles);
  for (const [k, t] of b.tiles) tiles.set(k, t);
  return { ...b, tiles: [...tiles], clear: a.clear, file: b.file ?? a.file };
}

/**
 * Writes a snapshot: a replace's clear, the mask copy, the tiles TILE_BATCH per transaction with a yield after each,
 * then the record (last, so a record's tiles are all written), then evicts beyond MAX_SESSIONS. Resolves true when
 * a record was written; with no labels it deletes the session if `owned` (saved from this page) and resolves false.
 */
export async function writeSnapshot(sessions: SessionStore, p: Snapshot, owned: boolean, now: () => number, yieldTask: () => Promise<void>): Promise<boolean> {
  if (!p.labelled) {
    if (owned) await sessions.delete(p.key);
    return false;
  }
  if (p.clear) await sessions.clearTiles(p.key);
  if (p.file) await sessions.saveBase(p.key, p.file);
  for (const b of batches(p.tiles.map(([k]) => k), TILE_BATCH)) {
    const set = new Set(b);
    await sessions.putTiles(p.key, p.tiles.filter(([k]) => set.has(k)));
    await yieldTask();
  }
  await sessions.putRecord({ ...p.record, savedAt: now() });
  for (const k of evict(await sessions.list(), MAX_SESSIONS)) await sessions.delete(k);
  return true;
}

/** A saved session's tiles, read TILE_BATCH at a time, and its mask from the copy; missing when the copy can't be opened. */
export async function loadSession(sessions: SessionStore, r: SessionRecord, grid: Grid, openBase: (file: Blob) => Promise<LabelSource>) {
  const tiles = new Map<string, Uint8Array>();
  for (let after: string | null = null; ;) {
    const batch = await sessions.tiles(r.key, after, TILE_BATCH);
    for (const [k, buf] of batch) tiles.set(k, new Uint8Array(buf));
    if (batch.length < TILE_BATCH) break;
    after = batch[batch.length - 1]![0];
  }
  let base: MaskBase | null = null, missing = false;
  if (r.base) {
    try {
      const blob = await sessions.base(r.key);
      if (!blob) throw new Error("no mask copy");
      base = { file: await openBase(blob), lut: r.base.lut, count: r.base.count, windows: new Set(r.base.windows), preview: restoredPreview(grid, r.base.values) };
    } catch { missing = true; }
  }
  return { tiles, base, missing };
}
