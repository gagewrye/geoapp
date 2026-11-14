import { restoredPreview } from "../core/session";
import type { LabelSource } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import type { SessionRecord, SessionStore } from "../io/session";
import type { Pending, Session } from "./sessionState";
import { mergeSnapshots, type Snapshot } from "./snapshot";

// Spec 056: a raster's snapshot still pending when the raster opens again (its save was on the way at the open, then
// failed). It is never written over the session that opens: if that restores its id, its labels go on the map and
// save with the session; else it keeps its own id as a replaced session, which the restore offer still reaches.

/** The opening session's raster's pending snapshots from an earlier open; none is written until its offer settles. */
export const strays = (pending: readonly Pending[], s: Session): Pending[] =>
  pending.filter((p) => p.s !== s && p.snap.record.raster === s.raster);

/** A stray the opening session doesn't restore: written as the replaced session, its stored record demoted now. */
export async function keepApart(s: Session, p: Pending, records: SessionRecord[], sessions: SessionStore): Promise<void> {
  p.snap = { ...p.snap, record: { ...p.snap.record, role: "replaced" } };
  s.replaced ??= { id: p.snap.id, savedAt: Math.max(p.s.lastChange, p.s.savedAt ?? 0), exportedAt: p.snap.record.exportedAt };
  const r = records.find((x) => x.id === p.snap.id);
  // so it is never a second current session, which no offer reaches; failing, its snapshot's record does it when written
  if (r && r.role !== "replaced") await sessions.putRecord({ ...r, role: "replaced" }).catch(() => {});
}

type Loaded = { tiles: Map<string, Uint8Array>; base: MaskBase | null; missing: boolean };

/**
 * The restored session's labels with its strays laid over, oldest first: what the map shows. The session is marked to
 * save all of it again (tiles, record, mask copy), so the strays are dropped from the queue.
 */
export async function adopt(s: Session, mine: Pending[], loaded: Loaded, openBase: (file: Blob) => Promise<LabelSource>): Promise<Loaded & { record: Snapshot["record"] }> {
  const snap = mine.map((p) => p.snap).reduce(mergeSnapshots);
  const tiles = snap.clear ? new Map<string, Uint8Array>() : loaded.tiles;
  for (const [k, t] of snap.tiles) if (t) tiles.set(k, new Uint8Array(t.slice(0))); else tiles.delete(k);
  let { base, missing } = loaded;
  const b = snap.record.base;
  if (!b) { base = null; missing = false; }
  else if (snap.file) {
    // its import's own file: the stored copy, if any, is older or was never written whole
    try {
      base = { file: await openBase(snap.file), lut: b.lut, count: b.count, windows: new Set(b.windows), preview: restoredPreview(s.grid, b.values) };
      missing = false;
    } catch { base = null; missing = true; }
  } else if (b.copyMissing) { base = null; missing = true; }
  s.tiles = new Set(snap.clear ? tiles.keys() : snap.tiles.map(([k]) => k));
  s.clear = snap.clear; s.record = true; s.file = snap.file; s.copied = !snap.file;
  s.copyFails = Math.max(0, ...mine.map((p) => p.copyFails ?? 0));
  if (snap.savedAt === null) { s.touched = true; s.lastChange = Math.max(s.lastChange, ...mine.map((p) => p.s.lastChange)); }
  s.exportedAt = snap.record.exportedAt; s.demote = snap.demote; s.drop = snap.drop;
  return { tiles, base, missing, record: snap.record };
}
