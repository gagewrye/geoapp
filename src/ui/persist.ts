// Over ~200 lines: one raster session state machine (open, restore offer, changes, replace, export), whose writes are in saveQueue.ts
import type { LabelClass } from "../core/classes";
import type { LabelStore } from "../core/labelStore";
import { exportedSince, rasterKey, sessionId } from "../core/session";
import type { Grid } from "../core/types";
import { openLabelFile, type LabelSource } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import type { SessionRecord, SessionStore } from "../io/session";
import { yieldToBrowser } from "../io/yieldTask";
import { MESSAGES, type MessageKind } from "./messages";
import { chooseSession, settle } from "./restoreOffer";
import { saveQueue } from "./saveQueue";
import { adopt, keepApart, spare, strays } from "./strays";
import { newSession, type Session } from "./sessionState";
import { loadSession, type Snapshot } from "./snapshot";

export { MAX_SESSIONS, TILE_BATCH } from "./snapshot";
/** Spec 031: a save starts this long after the last change. */
export const SAVE_DELAY_MS = 2000;
export { COPY_RETRIES, RETRY_MS } from "./saveQueue";

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
  /** #message: a save that fails says so there (spec 075 scope 5). */
  say?: (text: string, kind?: MessageKind) => void;
  yieldTask?: () => Promise<void>;
  now?: () => number;
  /** navigator.storage.persist, asked once at the first save (ADR 0025). */
  persistStorage?: () => void;
  openBase?: (file: Blob) => Promise<LabelSource>;
  time?: (ms: number) => string;
  dateTime?: (ms: number) => string;
};


/** Saves the labels in this browser as they change and offers them back on reopening the raster (specs 031, 075, ADRs 0025, 0042). */
// Changes mark tile keys and the record dirty; a save copies them (a snapshot) and writes it, one save at a time,
// after any pending snapshots.
export function initPersist(d: Deps) {
  const { labels, state, win, doc } = d;
  const now = d.now ?? Date.now, yieldTask = d.yieldTask ?? yieldToBrowser;
  const time = d.time ?? ((ms) => new Date(ms).toLocaleTimeString());
  const dateTime = d.dateTime ?? ((ms) => new Date(ms).toLocaleString());
  let db: Promise<SessionStore> | null = null;
  // every delete (a drop, an eviction, a declined restore, labels gone) also drops that session's pending snapshots (spec 075)
  const watched = (s: SessionStore): SessionStore => new Proxy(s, {
    get: (t, k) => {
      if (k === "delete") return async (id: string) => { await t.delete(id); q.deleted(id); };
      const v = t[k as keyof SessionStore];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const store = () => (db ??= d.open().then(watched));
  let current: Session | null = null;
  // a restore that laid a stray's import over reads the user's own file: never swapped for the copy (spec 076 scope 3)
  let adopted: { base: MaskBase; file: Blob } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let applying = false, guarded = false;
  const q = saveQueue({ store, current: () => current, save: () => save(false), sync: () => sync(), now, yieldTask, time, say: d.say, persistStorage: d.persistStorage });

  const dirty = (s: Session | null) => !!s && (s.tiles.size > 0 || s.record || s.clear || s.file !== null || s.demote !== null);
  // changes to a raster with no labels, and no session saved from this page, have nothing to save (an open resets the view)
  const unsaved = (s: Session | null) => dirty(s) && (s!.owned || labels.hasLabels());
  const guard = (e: Event) => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ""; };
  /** #save-state and the beforeunload guard: on iff something is dirty, a save is in flight, the last failed, or a snapshot is pending. */
  function sync(): void {
    const st = q.status();
    state.textContent = st.text;
    state.classList?.toggle("error", st.text.startsWith("Not saved"));
    const on = unsaved(current) || st.busy;
    if (on === guarded) return;
    guarded = on;
    if (on) win.addEventListener("beforeunload", guard); else win.removeEventListener("beforeunload", guard);
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; save(false); }, SAVE_DELAY_MS);
  }
  const changed = (s: Session) => { s.touched = true; s.lastChange = now(); if (s.ready) schedule(); sync(); };

  /** Copies what changed in s now; null when nothing did or it may not save yet. */
  function take(s: Session): Snapshot | null {
    if (!s.ready || !unsaved(s)) return null;
    const store = labels.store(), base = labels.base(), view = labels.view();
    const tiles = [...s.tiles].map((k): [string, ArrayBuffer | null] => [k, store.tiles.get(k)?.slice().buffer ?? null]);
    const record: Omit<SessionRecord, "savedAt"> = {
      id: s.id, raster: s.raster, role: "current", exportedAt: s.exportedAt,
      name: s.name, classes: labels.classes().map((c) => ({ ...c })), selected: labels.selected(), ...view,
      base: base && { lut: base.lut.slice(), count: base.count, windows: [...base.windows], values: base.preview.values.slice() },
    };
    const labelled = labels.hasLabels();
    const snap: Snapshot = { id: s.id, tiles, clear: s.clear, file: s.noCopy ? null : s.file, record, savedAt: s.touched ? null : s.savedAt, labelled, demote: s.demote, drop: s.drop, taken: q.tick() };
    s.tiles = new Set(); s.record = false; s.clear = false; s.file = null; s.touched = false; s.demote = null; s.drop = [];
    s.kept = labelled;
    return snap;
  }

  /** Starts a save of the current session's changes, after any pending snapshot; force: a hidden or closing tab, which doesn't wait for a stroke. */
  function save(force: boolean): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!force && labels.stroking()) { schedule(); return; }
    const snap = current && take(current);
    if (snap || q.pending().length) q.enqueue(snap ? current : null, snap);
  }

  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") save(true); });
  win.addEventListener("pagehide", () => save(true));

  return {
    /**
     * A raster is about to open (before the labels switch to it). With a snapshot pending, first asks to discard it;
     * else, with labels open, asks to close them (spec 032 scope 6). False on Cancel, and the open must stop.
     * Then the old raster's changes are copied and saved now, and the saved sessions' lookup starts; the new
     * raster saves nothing until offer() settles.
     */
    open(name: string, size: number, grid: Grid, hasLabels = false): boolean {
      const p = q.pending()[0];
      if (!p && hasLabels && !d.confirm(MESSAGES.discard)) return false;
      if (p) {
        if (!d.confirm(MESSAGES.pendingDiscard(p.snap.record.name, p.reason))) return false;
        q.discard();
      }
      if (current) save(true);
      const raster = rasterKey(size, grid);
      const s = newSession(raster, name, grid);
      // after the writes on the way, so the offer sees them (and their failures, kept as strays); a failed lookup counts as no session
      s.lookup = q.idle().then(store).then((db) => db.forRaster(raster)).catch(() => []).then((r) => { s.settled = true; s.found = r.length > 0; return r; });
      current = s;
      adopted = null;
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
        const records = await s.lookup;
        const loose = strays(q.pending(), s), ids = loose.map((p) => p.snap.id);
        if (s !== current || (!records.length && !loose.length)) return null;
        const sessions = await store();
        const c = records.length ? chooseSession(records, d.confirm, dateTime) : { restore: null, replaced: null, deleted: [] };
        const { choice, laidOver } = spare(c, records, ids);
        const r = await settle(s, sessions, choice, records, ids);
        for (const p of loose) if (p.snap.id !== r?.id) await keepApart(s, p, records, sessions);
        if (!r) return null;
        const openBase = d.openBase ?? openLabelFile;
        const loaded = await loadSession(sessions, r, s.grid, openBase);
        if (s !== current) return null;
        const mine = loose.filter((p) => p.snap.id === r.id);
        const { tiles, base, missing, record: v } = mine.length ? await adopt(s, mine, loaded, openBase) : { ...loaded, record: r };
        q.forget(mine);
        adopted = mine.length && base && s.file ? { base, file: s.file } : null;
        applying = true;
        try {
          labels.restoreSession({ width: s.grid.width, height: s.grid.height, tiles, base: base !== null }, v.classes, base, v.selected, { opacity: v.opacity, visible: v.visible });
        } finally { applying = false; }
        s.owned = s.kept = true;
        if (missing) s.record = true; // saved again without the mask
        const said = missing ? MESSAGES.restoredNoMask : MESSAGES.restored;
        return laidOver ? (missing ? `${MESSAGES.restoredStray} ${MESSAGES.restoredNoMask}` : MESSAGES.restoredStray) : said;
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
      changed(current);
    },
    /** A stroke ended: its changes save SAVE_DELAY_MS from now. */
    strokeEnded(): void {
      if (current?.ready && dirty(current)) schedule();
    },
    /** Classes, the selected class or the view changed. */
    record(): void {
      if (applying || !current) return;
      current.record = true;
      changed(current);
    },
    /** Why an import may not replace the labels now: a stored replaced session it would drop isn't exported since its last change (spec 075 scope 2). */
    replaceRefused(): string | null {
      return current?.replaced.some((r) => !exportedSince(r)) ? MESSAGES.replacedFirst : null;
    },
    /** The labels are about to be replaced: their unsaved changes are copied and saved now, under their own session. */
    flush(): void { save(true); },
    /**
     * The labels were replaced (an import). Saved labels become the raster's replaced session, and the exported ones
     * before them are dropped (ADR 0042); the new labels start a new current session, every tile of it written.
     */
    replaced(): void {
      const s = current;
      if (applying || !s) return;
      if (s.kept) {
        const old = s.replaced, gone = old.filter(exportedSince);
        // replaceRefused keeps an unexported one from getting here; were one to, it stays, as another replaced session
        s.drop = [...s.drop, ...gone.map((r) => r.id)];
        s.demote = s.id;
        // its last change, saved or not (a flush may still be writing, or have failed): spec 075 drops it only if exported after
        s.replaced = [...old.filter((r) => !gone.includes(r)), { id: s.id, savedAt: Math.max(s.savedAt ?? now(), s.lastChange), exportedAt: s.exportedAt }];
        if (s.failed) {
          q.hold({ s, snap: { ...s.failed, record: { ...s.failed.record, role: "replaced" } }, reason: q.failed() || "not saved yet" });
          s.failed = null;
        }
        s.id = sessionId(s.raster, [s.id, ...old.map((r) => r.id)]);
        s.owned = s.kept = false; s.savedAt = s.exportedAt = null;
      }
      s.clear = true;
      s.record = true;
      s.tiles = new Set(labels.store().tiles.keys());
      changed(s);
    },
    /** An import loaded this mask file: it is copied once, with the next save; `use` gets the copy once written whole (ADR 0041). */
    imported(file: Blob, use?: (copy: Blob) => Promise<void>): void {
      if (!current) return;
      if (use) q.uses.set(file, use);
      current.file = file;
      current.noCopy = false; // a new import tries the copy again
      current.copyFails = 0;
      current.copied = false;
      changed(current);
    },
    /** Resolves once the current import's mask copy is written or has failed; at once when none is due (spec 076 scope 1). */
    async waitCopy(): Promise<void> {
      const s = current;
      if (!s || s.copied || s.noCopy || s.copyFails > 0 || !s.ready) return;
      save(true);
      await q.idle();
    },
    /**
     * A verified export of the labels finished at `at` (spec 075 scope 6): the session records it, saved now. Edits were
     * locked from the export's click, so any change not saved yet is in the file: it is saved as of the export.
     */
    exported(at: number): void {
      const s = current;
      if (!s || !s.ready) return;
      s.exportedAt = at;
      if (s.touched) { s.touched = false; s.savedAt = at; s.lastChange = Math.min(s.lastChange, at); }
      s.record = true;
      save(false);
    },
    /** The user's file the restored base reads in place of a copy (a stray's import), while it is the base; else null. */
    maskUncopied: (): Blob | null => (adopted && labels.base() === adopted.base ? adopted.file : null),
    /** The saves started so far have ended (tests). */
    idle: () => q.idle(),
    /** A save is scheduled or in flight (e2e: __geoapp.saving, spec 072). */
    saving: () => timer !== null || q.writing(),
  };
}
