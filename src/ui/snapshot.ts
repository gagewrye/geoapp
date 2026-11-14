import type { LabelSource } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import { batches, byRaster, evict, restoredPreview } from "../core/session";
import type { Grid } from "../core/types";
import type { SessionRecord, SessionStore } from "../io/session";

/** Tiles per IndexedDB transaction (about 1 MiB), and per read on restore (spec 031). */
export const TILE_BATCH = 16;
/** Rasters whose sessions are kept; past it, the least recently saved exported ones go, with their mask copies (spec 056). */
export const MAX_SESSIONS = 8;

/** One session's changes, copied when a save starts (spec 031): tiles (null for a deleted one), the record, a replace's clear and mask file. */
export type Snapshot = {
  id: string;
  tiles: [string, ArrayBuffer | null][];
  clear: boolean;
  file: Blob | null;
  record: Omit<SessionRecord, "savedAt">;
  /** The savedAt to keep when only exportedAt changed (spec 056 scope 6); null saves the time of the write. */
  savedAt: number | null;
  /** Labels existed when copied; with none, a saved session is deleted instead. */
  labelled: boolean;
  /** An import replaced session `demote`, which becomes the raster's replaced one; `drop`, the replaced one before it, is deleted (ADR 0037). */
  demote: string | null;
  drop: string | null;
  /** When it was copied, on the save queue's clock: a session deleted after that never gets it written back. */
  taken?: number;
};

/** The mask copy failed after the tiles and record were written (spec 056 scope 3). */
export class CopyFailed extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "CopyFailed";
  }
}

/** a then b, as one snapshot of the same session: b's tiles and record win, and b's clear drops a's tiles. */
export function mergeSnapshots(a: Snapshot, b: Snapshot): Snapshot {
  const keep = { file: b.file ?? a.file, savedAt: a.savedAt === null ? null : b.savedAt, demote: b.demote ?? a.demote, drop: b.drop ?? a.drop };
  if (b.clear) return { ...b, ...keep };
  const tiles = new Map(a.tiles);
  for (const [k, t] of b.tiles) tiles.set(k, t);
  return { ...b, ...keep, tiles: [...tiles], clear: a.clear };
}

/**
 * Writes a snapshot (spec 056 scope 3): the replaced sessions' roles, a clear, the tiles TILE_BATCH per transaction with
 * a yield after each, the record (with copyMissing while a copy is due), then the mask copy and the record again
 * without the flag. So a failing copy never blocks tiles. Then evicts other rasters' exported sessions past
 * MAX_SESSIONS. Resolves with the savedAt written; with no labels it deletes the session if `owned` and resolves null.
 */
// keep: rasters with snapshots still to write, whose newer labels the store doesn't show yet, so never evicted
export async function writeSnapshot(sessions: SessionStore, p: Snapshot, owned: boolean, now: () => number, yieldTask: () => Promise<void>,
  keep: Iterable<string> = []): Promise<number | null> {
  if (p.drop) await sessions.delete(p.drop);
  if (p.demote) {
    const old = (await sessions.forRaster(p.record.raster)).find((r) => r.id === p.demote);
    if (old) await sessions.putRecord({ ...old, role: "replaced" });
  }
  if (!p.labelled) {
    if (owned) await sessions.delete(p.id);
    return null;
  }
  if (p.clear) await sessions.clearTiles(p.id);
  for (const b of batches(p.tiles.map(([k]) => k), TILE_BATCH)) {
    const set = new Set(b);
    await sessions.putTiles(p.id, p.tiles.filter(([k]) => set.has(k)));
    await yieldTask();
  }
  const savedAt = p.savedAt ?? now();
  const record = { ...p.record, savedAt };
  const base = record.base;
  await sessions.putRecord(p.file && base ? { ...record, base: { ...base, copyMissing: true } } : record);
  if (p.file) {
    try {
      await sessions.saveBase(p.id, p.file);
    } catch (e) {
      throw new CopyFailed(e);
    }
    await sessions.putRecord(record);
  } else if (base?.copyMissing) await sessions.deleteBase(p.id).catch(() => {}); // an older import's copy goes, if the disk lets it
  await evictOthers(sessions, p.record.raster, new Set(keep));
  return savedAt;
}

/** Deletes every session of the rasters evict picks among the others: the open raster's are never evicted. */
async function evictOthers(sessions: SessionStore, raster: string, keep: Set<string>): Promise<void> {
  const all = (await sessions.list()).filter((x) => x.raster !== raster);
  // a kept raster still counts towards the limit, but is never picked
  const others = all.map((x) => (keep.has(x.raster) ? { ...x, exportedAt: null } : x));
  for (const r of evict(byRaster(others), MAX_SESSIONS - 1)) {
    for (const x of others) if (x.raster === r) await sessions.delete(x.id);
  }
}

/** A saved session's tiles, read TILE_BATCH at a time, and its mask from the copy; missing when the copy can't be opened. */
export async function loadSession(sessions: SessionStore, r: SessionRecord, grid: Grid, openBase: (file: Blob) => Promise<LabelSource>) {
  const tiles = new Map<string, Uint8Array>();
  for (let after: string | null = null; ;) {
    const batch = await sessions.tiles(r.id, after, TILE_BATCH);
    for (const [k, buf] of batch) tiles.set(k, new Uint8Array(buf));
    if (batch.length < TILE_BATCH) break;
    after = batch[batch.length - 1]![0];
  }
  let base: MaskBase | null = null, missing = false;
  if (r.base?.copyMissing) missing = true;
  else if (r.base) {
    try {
      const blob = await sessions.base(r.id);
      if (!blob) throw new Error("no mask copy");
      base = { file: await openBase(blob), lut: r.base.lut, count: r.base.count, windows: new Set(r.base.windows), preview: restoredPreview(grid, r.base.values) };
    } catch { missing = true; }
  }
  return { tiles, base, missing };
}
