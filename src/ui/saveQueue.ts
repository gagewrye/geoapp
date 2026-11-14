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
  // an import's file, and what to do with its copy once written
  const uses = new WeakMap<Blob, (copy: Blob) => Promise<void>>();

  async function write(s: Session, snap: Snapshot): Promise<void> {
    const sessions = await d.store();
    if (!persisted) { persisted = true; d.persistStorage?.(); }
    // decided now, not when copied: saves run one at a time, so every earlier copy attempt has ended and `copied` is
    // accurate. A record saved without its import's copy says so, so a restore never opens an older copy (spec 032)
    if (snap.record.base && !snap.file && !s.copied) snap.record.base.copyMissing = true;
    const at = await writeSnapshot(sessions, snap, s.owned && snap.id === s.id, d.now, d.yieldTask);
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
   * COPY_RETRIES failed copy retries, the mask copy is left out until the next import (specs 032, 056). A snapshot
   * never tried (`attempted` false: a pending one before it failed) is dirty again in full, and counts no failure.
   */
  function lost(s: Session, snap: Snapshot, e: unknown, attempted = true): void {
    const quota = attempted && isQuota(e), copy = attempted && e instanceof CopyFailed;
    if (copy && ++s.copyFails > COPY_RETRIES) s.noCopy = true;
    if (quota) s.noCopy = true;
    if (s === d.current() && snap.id === s.id) {
      if (copy) s.file ??= snap.file;
      else {
        for (const [k] of snap.tiles) s.tiles.add(k);
        s.record = true; s.clear ||= snap.clear; s.file ??= snap.file; s.demote ??= snap.demote; s.drop ??= snap.drop;
        if (snap.savedAt === null) s.touched = true;
        s.failed = s.failed ? mergeSnapshots(s.failed, snap) : snap; // the tiles as they were, should an import replace them
      }
    } else {
      // a session an import replaced while its save was on the way is the replaced one now
      if (s.replaced?.id === snap.id) snap = { ...snap, record: { ...snap.record, role: "replaced" } };
      const i = pending.findIndex((p) => p.s === s && p.snap.id === snap.id);
      const merged = i >= 0 ? mergeSnapshots(pending[i]!.snap, snap) : snap;
      const p = { s, snap: quota || s.noCopy ? withoutCopy(merged) : merged, reason: reasonOf(e) };
      if (i >= 0) pending[i] = p; else pending.push(p);
    }
    retryLater();
  }

  /** Writes the pending snapshots, if any, then this one. */
  function enqueue(s: Session | null, snap: Snapshot | null): void {
    inFlight++;
    d.sync();
    chain = chain.then(async () => {
      for (const p of [...pending]) {
        try {
          await write(p.s, p.snap);
          pending = pending.filter((x) => x !== p);
        } catch (e) {
          if (pending.includes(p)) {
            p.reason = reasonOf(e);
            // as for the open raster: the copy is left out after a quota error or COPY_RETRIES failed retries
            if (isQuota(e) || (e instanceof CopyFailed && ++p.s.copyFails > COPY_RETRIES)) p.snap = withoutCopy(p.snap);
          }
          if (s && snap) lost(s, snap, e, false);
          retryLater();
          return reasonOf(e);
        }
      }
      if (!s || !snap) return "";
      try { await write(s, snap); return ""; } catch (e) { lost(s, snap, e); return reasonOf(e); }
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
    pending: () => pending,
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
