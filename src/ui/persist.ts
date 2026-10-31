import type { LabelClass } from "../core/classes";
import type { LabelStore } from "../core/labelStore";
import { rasterKey } from "../core/session";
import type { Grid } from "../core/types";
import { openLabelFile, type LabelSource } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import type { SessionRecord, SessionStore } from "../io/session";
import { yieldToBrowser } from "../io/yieldTask";
import { MESSAGES } from "./messages";
import { loadSession, mergeSnapshots, writeSnapshot, type Snapshot } from "./snapshot";

export { MAX_SESSIONS, TILE_BATCH } from "./snapshot";
/** Spec 031: a save starts this long after the last change. */
export const SAVE_DELAY_MS = 2000;
/** While a previous raster's snapshot is pending (scope 8), a save is tried this often. */
export const RETRY_MS = 30_000;

/** What persistence reads from and restores into the labels. */
export type PersistLabels = {
  store(): LabelStore;
  classes(): LabelClass[];
  selected(): number;
  view(): { opacity: number; visible: boolean };
  base(): MaskBase | null;
  stroking(): boolean;
  hasLabels(): boolean;
  /** Swaps in a restored session; its replace must not count as an edit. */
  restoreSession(store: LabelStore, classes: LabelClass[], base: MaskBase | null, selected: number, view: { opacity: number; visible: boolean }): void;
  /** Spec 004's lock, held until the restore offer settles (scope 4). */
  restoreLock?(on: boolean): void;
};

type Deps = {
  labels: PersistLabels;
  /** Opens the store; called once, on first use. */
  open: () => Promise<SessionStore>;
  /** #save-state; its Not saved text has class error (spec 032). */
  state: { textContent: string | null; classList?: { toggle(c: string, on: boolean): unknown } };
  win: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  doc: Pick<EventTarget, "addEventListener"> & { visibilityState: string };
  confirm: (text: string) => boolean;
  yieldTask?: () => Promise<void>;
  now?: () => number;
  /** navigator.storage.persist, asked once at the first save (ADR 0025). */
  persistStorage?: () => void;
  openBase?: (file: Blob) => Promise<LabelSource>;
  time?: (ms: number) => string;
  dateTime?: (ms: number) => string;
};

/** One raster's session: what changed since its last save, and whether it may save yet. */
type Session = {
  key: string; name: string; grid: Grid;
  /** The saved session's lookup, started at open; settled once it resolves (a failed one resolves null). */
  lookup: Promise<SessionRecord | null>; settled: boolean; found: boolean;
  /** Its restore offer has been answered (or there was none): until then nothing saves over the saved one. */
  ready: boolean;
  /** A record of it is saved from this page, so labels going to none delete it. */
  owned: boolean;
  tiles: Set<string>; record: boolean; clear: boolean; file: Blob | null;
  /** A save hit the quota (spec 032 scope 5): the mask copy is left out until the next import. */
  noCopy: boolean;
};

/** A previous raster's snapshot whose write failed (scope 8): kept and written before anything else. */
type Pending = { s: Session; snap: Snapshot; reason: string };

const isQuota = (e: unknown) => e instanceof DOMException && e.name === "QuotaExceededError";
const reasonOf = (e: unknown) => isQuota(e) ? "the browser's storage is full" : e instanceof Error && e.message ? e.message : String(e);

/** Saves the labels in this browser as they change and offers them back on reopening the raster (spec 031, ADR 0025). */
// Changes mark tile keys and the record dirty; a save copies them (a snapshot) and writes it, one save at a time,
// after any pending snapshot of a previous raster.
export function initPersist(d: Deps) {
  const { labels, state, win, doc } = d;
  const now = d.now ?? Date.now, yieldTask = d.yieldTask ?? yieldToBrowser;
  const time = d.time ?? ((ms) => new Date(ms).toLocaleTimeString());
  const dateTime = d.dateTime ?? ((ms) => new Date(ms).toLocaleString());
  let db: Promise<SessionStore> | null = null;
  const store = () => (db ??= d.open());
  let current: Session | null = null, pending: Pending | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, retry: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0, failed = "", saved = "", applying = false, persisted = false, guarded = false;

  const dirty = (s: Session | null) => !!s && (s.tiles.size > 0 || s.record || s.clear || s.file !== null);
  // changes to a raster with no labels, and no session saved from this page, have nothing to save (an open resets the view)
  const unsaved = (s: Session | null) => dirty(s) && (s!.owned || labels.hasLabels());
  const guard = (e: Event) => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ""; };
  /** #save-state and the beforeunload guard: on iff something is dirty, a save is in flight, the last failed, or a snapshot is pending. */
  function sync(): void {
    state.textContent = pending ? `Not saved: ${pending.snap.record.name}: ${pending.reason}`
      : inFlight > 0 ? "Saving…" : failed ? `Not saved: ${failed}` : saved;
    state.classList?.toggle("error", state.textContent.startsWith("Not saved"));
    const on = unsaved(current) || inFlight > 0 || failed !== "" || pending !== null;
    if (on === guarded) return;
    guarded = on;
    if (on) win.addEventListener("beforeunload", guard); else win.removeEventListener("beforeunload", guard);
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; save(false); }, SAVE_DELAY_MS);
  }
  const changed = () => { if (current?.ready) schedule(); sync(); };

  /** Copies what changed in s now; null when nothing did or it may not save yet. */
  function take(s: Session): Snapshot | null {
    if (!s.ready || !unsaved(s)) return null;
    const store = labels.store(), base = labels.base(), view = labels.view();
    const tiles = [...s.tiles].map((k): [string, ArrayBuffer | null] => [k, store.tiles.get(k)?.slice().buffer ?? null]);
    const record = {
      key: s.key, name: s.name, classes: labels.classes().map((c) => ({ ...c })), selected: labels.selected(), ...view,
      base: base && { lut: base.lut.slice(), count: base.count, windows: [...base.windows], values: base.preview.values.slice() },
    };
    const snap = { key: s.key, tiles, clear: s.clear, file: s.noCopy ? null : s.file, record, labelled: labels.hasLabels() };
    s.tiles = new Set(); s.record = false; s.clear = false; s.file = null;
    return snap;
  }

  async function write(s: Session, snap: Snapshot): Promise<void> {
    const sessions = await store();
    if (!persisted) { persisted = true; d.persistStorage?.(); }
    s.owned = await writeSnapshot(sessions, snap, s.owned, now, yieldTask);
  }

  const retryLater = () => { retry ??= setTimeout(() => { retry = null; save(false); }, RETRY_MS); };

  /**
   * A snapshot that wasn't written: the current raster's is dirty again; another raster's becomes (or joins) the pending
   * one. Either is tried again after RETRY_MS (new changes still save after SAVE_DELAY_MS). After a quota error the mask
   * copy is left out until the next import: a full disk would otherwise stream the whole mask on every try (spec 032).
   */
  function lost(s: Session, snap: Snapshot, e: unknown): void {
    const quota = isQuota(e);
    if (quota) s.noCopy = true;
    if (s === current) {
      for (const [k] of snap.tiles) s.tiles.add(k);
      s.record = true; s.clear ||= snap.clear; s.file ??= snap.file;
    } else {
      const merged = pending?.s === s ? mergeSnapshots(pending.snap, snap) : snap;
      pending = { s, snap: quota ? { ...merged, file: null } : merged, reason: reasonOf(e) };
    }
    retryLater();
  }

  /** Writes the pending snapshot, if any, then this one. */
  function enqueue(s: Session | null, snap: Snapshot | null): void {
    inFlight++;
    sync();
    chain = chain.then(async () => {
      const p = pending;
      if (p) {
        try {
          await write(p.s, p.snap);
          if (pending === p) pending = null;
        } catch (e) {
          if (pending === p) { p.reason = reasonOf(e); if (isQuota(e)) p.snap = { ...p.snap, file: null }; }
          if (s && snap) lost(s, snap, e);
          retryLater();
          return reasonOf(e);
        }
      }
      if (!s || !snap) return "";
      try { await write(s, snap); return ""; } catch (e) { lost(s, snap, e); return reasonOf(e); }
    }).then((reason) => {
      failed = reason;
      if (!reason && !pending) saved = `Saved ${time(now())}`;
      if (!reason && !pending && retry) { clearTimeout(retry); retry = null; }
    }).finally(() => { inFlight--; sync(); });
  }

  /** Starts a save of the current session's changes, after any pending snapshot; force: a hidden or closing tab, which doesn't wait for a stroke. */
  function save(force: boolean): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!force && labels.stroking()) { schedule(); return; }
    const snap = current && take(current);
    if (snap || pending) enqueue(snap ? current : null, snap);
  }

  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") save(true); });
  win.addEventListener("pagehide", () => save(true));

  return {
    /**
     * A raster is about to open (before the labels switch to it). With a snapshot pending, first asks to discard it;
     * else, with labels open, asks to close them (spec 032 scope 6). False on Cancel, and the open must stop.
     * Then the old raster's changes are copied and saved now, and the saved session's lookup starts; the new
     * raster saves nothing until offer() settles.
     */
    open(name: string, size: number, grid: Grid, hasLabels = false): boolean {
      if (!pending && hasLabels && !d.confirm(MESSAGES.discard)) return false;
      if (pending) {
        if (!d.confirm(MESSAGES.pendingDiscard(pending.snap.record.name, pending.reason))) return false;
        pending = null;
        if (retry) { clearTimeout(retry); retry = null; }
        failed = ""; saved = "";
      }
      if (current) save(true);
      const key = rasterKey(size, grid);
      const s: Session = { key, name, grid, lookup: Promise.resolve(null), settled: false, found: false, ready: false, owned: false, tiles: new Set(), record: false, clear: false, file: null, noCopy: false };
      // a failed lookup counts as no session
      s.lookup = store().then((db) => db.get(key)).catch(() => null).then((r) => { s.settled = true; s.found = r !== null; return r; });
      current = s;
      sync();
      return true;
    },
    /** At "Raster opened.": offers a saved session back, the labels locked until it settles. Resolves with the message to show, or null. */
    async offer(): Promise<string | null> {
      const s = current;
      if (!s || s.ready) return null;
      const locked = !s.settled || s.found; // a lookup that already found nothing needs no lock
      if (locked) labels.restoreLock?.(true);
      try {
        const r = await s.lookup;
        if (s !== current || !r) return null;
        const sessions = await store();
        if (!d.confirm(MESSAGES.restore(dateTime(r.savedAt), r.name))) { await sessions.delete(s.key); return null; }
        const { tiles, base, missing } = await loadSession(sessions, r, s.grid, d.openBase ?? openLabelFile);
        if (s !== current) return null;
        applying = true;
        try {
          labels.restoreSession({ width: s.grid.width, height: s.grid.height, tiles, base: base !== null }, r.classes, base, r.selected, { opacity: r.opacity, visible: r.visible });
        } finally { applying = false; }
        s.owned = true;
        if (missing) s.record = true; // saved again without the mask
        return missing ? MESSAGES.restoredNoMask : MESSAGES.restored;
      } finally {
        // another raster's open has unlocked the labels already, and may hold its own lock
        if (s === current) {
          if (locked) labels.restoreLock?.(false);
          s.ready = true;
          if (dirty(s)) schedule();
          sync();
        }
      }
    },
    /** These tile keys changed: applied cells, an undo, erase to empty. */
    tiles(keys: Iterable<string>): void {
      if (applying || !current) return;
      for (const k of keys) current.tiles.add(k);
      changed();
    },
    /** A stroke ended: its changes save SAVE_DELAY_MS from now. */
    strokeEnded(): void {
      if (current?.ready && dirty(current)) schedule();
    },
    /** Classes, the selected class or the view changed. */
    record(): void {
      if (applying || !current) return;
      current.record = true;
      changed();
    },
    /** The labels were replaced (an import): the old tiles are cleared before every new one is written. */
    replaced(): void {
      if (applying || !current) return;
      current.clear = true;
      current.record = true;
      current.tiles = new Set(labels.store().tiles.keys());
      changed();
    },
    /** An import loaded this mask file: it is copied once, with the next save. */
    imported(file: Blob): void {
      if (!current) return;
      current.file = file;
      current.noCopy = false; // a new import tries the copy again
      changed();
    },
    /** The saves started so far have ended (tests). */
    idle: () => chain,
  };
}
