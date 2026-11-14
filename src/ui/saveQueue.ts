import type { SessionStore } from "../io/session";
import { MESSAGES, type MessageKind } from "./messages";
import { isQuota, reasonOf, withoutCopy, type Pending, type Session } from "./sessionState";
import { CopyFailed, mergeSnapshots, writeSnapshot, type Snapshot } from "./snapshot";

/** While a snapshot is pending or failed (spec 031 scope 8, spec 032), a save is tried this often. */
export const RETRY_MS = 30_000;
/** Spec 056 scope 3: a mask copy failing for another reason than the quota is tried this many times more, then left out. */
export const COPY_RETRIES = 3;

type Deps = {
  store: () => Promise<SessionStore>;
  /** The open raster's session: a failed snapshot of it is marked dirty again, any other's is kept pending. */
  current: () => Session | null;
  /** Starts a save of the current session (the retry timer's). */
  save: () => void;
  /** Updates #save-state and the guard. */
  sync: () => void;
  now: () => number;
  yieldTask: () => Promise<void>;
  time: (ms: number) => string;
  say?: (text: string, kind?: MessageKind) => void;
  persistStorage?: () => void;
};

/** Spec 031's writes, one at a time: pending snapshots first, retries, the mask copy's use (ADR 0036) and the failure message (spec 056 scope 5). */
export function saveQueue(d: Deps) {
  let pending: Pending[] = [];
  let retry: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0, failed = "", saved = "", persisted = false, loud = true;
  // the queue's clock, and when each session id was last deleted: a snapshot copied before its session's delete is never written
  let clock = 0;
  const deletedAt = new Map<string, number>();
  const stale = (snap: Snapshot) => (snap.taken ?? 0) < (deletedAt.get(snap.id) ?? 0);
  // an import's file, and what to do with its copy once written
  const uses = new WeakMap<Blob, (copy: Blob) => Promise<void>>();

  async function write(s: Session, snap: Snapshot): Promise<void> {
    const sessions = await d.store();
    if (!persisted) { persisted = true; d.persistStorage?.(); }
    // decided now, not when copied: saves run one at a time, so every earlier copy attempt has ended and `copied` is
    // accurate. A record saved without its import's copy says so, so a restore never opens an older copy (spec 032)
    if (snap.record.base && !snap.file && !s.copied) snap.record.base.copyMissing = true;
    const at = await writeSnapshot(sessions, snap, s.owned && snap.id === s.id, d.now, d.yieldTask, pending.map((p) => p.snap.record.raster));
    if (snap.id !== s.id) return;
    if (s.failed) {
      const done = new Set(snap.tiles.map(([k]) => k));
      const left = s.failed.tiles.filter(([k]) => !done.has(k));
      s.failed = left.length ? { ...s.failed, tiles: left, clear: false, record: snap.record } : null;
    }
    s.owned = at !== null;
    if (at !== null) s.savedAt = at;
    if (!snap.file) return;
    s.copied = true;
    const use = uses.get(snap.file);
    const copy = use && await sessions.base(snap.id).catch(() => null);
    if (use && copy && copy.size === snap.file.size) await use(copy).catch(() => {}); // a short copy is never read
  }

  const retryLater = () => { retry ??= setTimeout(() => { retry = null; d.save(); }, RETRY_MS); };

  /**
   * A snapshot that wasn't written: the current session's is dirty again (only its file, when just its copy failed);
   * another session's becomes (or joins) a pending one. Either is tried again after RETRY_MS. After a quota error, or
   * COPY_RETRIES failed copy retries, the mask copy is left out until the next import (specs 032, 056).
   */
  function lost(s: Session, snap: Snapshot, e: unknown): void {
    const quota = isQuota(e), copy = e instanceof CopyFailed;
    const own = s === d.current() && snap.id === s.id;
    // only the session's own import counts against its copy; a replaced or earlier snapshot's are counted on its pending entry
    if (own && copy && ++s.copyFails > COPY_RETRIES) s.noCopy = true;
    if (own && quota) s.noCopy = true;
    if (own) {
      // its tiles and record are written: the retry keeps that savedAt, never an older one that an export may be after
      if (copy) { s.file ??= snap.file; s.owned = true; s.savedAt = (e as CopyFailed).savedAt; }
      else {
        for (const [k] of snap.tiles) s.tiles.add(k);
        s.record = true; s.clear ||= snap.clear; s.file ??= snap.file; s.demote ??= snap.demote; s.drop ??= snap.drop;
        if (snap.savedAt === null) s.touched = true;
        s.failed = s.failed ? mergeSnapshots(s.failed, snap) : snap; // the tiles as they were, should an import replace them
      }
    } else {
      if (stale(snap)) return; // its session was deleted meanwhile
      // a session an import replaced while its save was on the way is the replaced one now
      if (s.replaced?.id === snap.id) snap = { ...snap, record: { ...snap.record, role: "replaced" } };
      const i = pending.findIndex((p) => p.s === s && p.snap.id === snap.id);
      const merged = i >= 0 ? mergeSnapshots(pending[i]!.snap, snap) : snap;
      const copyFails = (i >= 0 ? pending[i]!.copyFails ?? 0 : 0) + (copy ? 1 : 0);
      const leaveOut = quota || copyFails > COPY_RETRIES || (s !== d.current() && s.noCopy);
      const p = { s, snap: leaveOut ? withoutCopy(merged) : merged, reason: reasonOf(e), copyFails };
      if (i >= 0) pending[i] = p; else pending.push(p);
    }
    retryLater();
  }

  /**
   * Writes the pending snapshots, if any, then this one. A pending one that fails stays queued for the retry, and the
   * rest are still written: one that keeps failing never blocks the open raster's saves.
   */
  function enqueue(s: Session | null, snap: Snapshot | null): void {
    inFlight++;
    d.sync();
    chain = chain.then(async () => {
      let reason = "";
      for (const p of [...pending]) {
        if (!pending.includes(p)) continue; // dropped by a delete meanwhile
        // the open raster's own strays wait for its offer (persist.ts): never written over the session that opened it
        const cur = d.current();
        if (cur && p.s !== cur && p.snap.record.raster === cur.raster && (!cur.ready || p.snap.id === cur.id)) continue;
        if (stale(p.snap)) { pending = pending.filter((x) => x !== p); continue; }
        try {
          await write(p.s, p.snap);
          pending = pending.filter((x) => x !== p);
        } catch (e) {
          if (pending.includes(p)) {
            p.reason = reasonOf(e);
            // as for the open raster: the copy is left out after a quota error or COPY_RETRIES failed retries
            if (e instanceof CopyFailed) p.copyFails = (p.copyFails ?? 0) + 1;
            if (isQuota(e) || (p.copyFails ?? 0) > COPY_RETRIES) p.snap = withoutCopy(p.snap);
          }
          reason ||= reasonOf(e);
          retryLater();
        }
      }
      if (s && snap) {
        try { await write(s, snap); } catch (e) { lost(s, snap, e); reason = reasonOf(e); }
      }
      return reason;
    }).then((reason) => {
      failed = reason;
      // spec 056 scope 5: said on the first failure, and again only after a save succeeded
      if (reason && loud) { loud = false; d.say?.(MESSAGES.notSaving(reason), "error"); }
      if (!reason && !pending.length) { loud = true; saved = `Saved ${d.time(d.now())}`; }
      if (!reason && !pending.length && retry) { clearTimeout(retry); retry = null; }
    }).finally(() => { inFlight--; d.sync(); });
  }

  return {
    enqueue, uses,
    /** The next tick of the queue's clock, which stamps each snapshot when copied. */
    tick: () => ++clock,
    /** Session `id` was deleted: its pending snapshots go, and none copied before now is ever written. */
    deleted(id: string): void {
      deletedAt.set(id, ++clock);
      pending = pending.filter((p) => p.snap.id !== id);
    },
    pending: () => pending,
    /** These pending snapshots are the open session's now (its restore adopted them). */
    forget: (ps: Pending[]) => { pending = pending.filter((p) => !ps.includes(p)); },
    /** Keeps a snapshot to write before anything else. */
    hold: (p: Pending) => { pending.push(p); },
    /** Drops every pending snapshot and the failure they caused (the user discarded them). */
    discard(): void {
      pending = [];
      if (retry) { clearTimeout(retry); retry = null; }
      failed = ""; saved = "";
    },
    /** #save-state's text, and whether a save is in flight or the last one failed. */
    status: () => {
      const p = pending[0];
      return { text: p ? `Not saved: ${p.snap.record.name}: ${p.reason}` : inFlight > 0 ? "Saving…" : failed ? `Not saved: ${failed}` : saved, busy: inFlight > 0 || failed !== "" || p !== undefined };
    },
    failed: () => failed,
    /** The writes queued so far have ended. */
    idle: () => chain,
  };
}
