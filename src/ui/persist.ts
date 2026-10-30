import type { LabelClass } from "../core/classes";
import type { LabelStore } from "../core/labelStore";
import { batches, evict, rasterKey, restoredPreview } from "../core/session";
import type { Grid } from "../core/types";
import { openLabelFile, type LabelSource } from "../io/labelFile";
import type { MaskBase } from "../io/maskBase";
import type { SessionRecord, SessionStore } from "../io/session";
import { yieldToBrowser } from "../io/yieldTask";
import { MESSAGES } from "./messages";

/** Spec 031: a save starts this long after the last change. */
export const SAVE_DELAY_MS = 2000;
/** Tiles per IndexedDB transaction (about 1 MiB), and per read on restore. */
export const TILE_BATCH = 16;
/** Sessions kept; the least recently saved goes first, with its mask copy. */
export const MAX_SESSIONS = 8;

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
  restore(store: LabelStore, classes: LabelClass[], base: MaskBase | null, selected: number, view: { opacity: number; visible: boolean }): void;
};

type Deps = {
  labels: PersistLabels;
  /** Opens the store; called once, on first use. */
  open: () => Promise<SessionStore>;
  /** #save-state. */
  state: { textContent: string | null };
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
  /** Its restore offer has been answered (or there was none): until then nothing saves over the saved one. */
  ready: boolean;
  /** A record of it is saved from this page, so labels going to none delete it. */
  owned: boolean;
  tiles: Set<string>; record: boolean; clear: boolean; file: Blob | null;
};

type Snapshot = { s: Session; tiles: [string, ArrayBuffer | null][]; clear: boolean; file: Blob | null; record: Omit<SessionRecord, "savedAt">; labelled: boolean };

const reasonOf = (e: unknown) =>
  e instanceof DOMException && e.name === "QuotaExceededError" ? "the browser's storage is full" : e instanceof Error && e.message ? e.message : String(e);

/** Saves the labels in this browser as they change and offers them back on reopening the raster (spec 031, ADR 0025). */
// Changes mark tile keys and the record dirty; a save copies them (a snapshot) and writes it in batches, one save at a time.
export function initPersist(d: Deps) {
  const { labels, state, win, doc } = d;
  const now = d.now ?? Date.now, yieldTask = d.yieldTask ?? yieldToBrowser;
  const time = d.time ?? ((ms) => new Date(ms).toLocaleTimeString());
  const dateTime = d.dateTime ?? ((ms) => new Date(ms).toLocaleString());
  let db: Promise<SessionStore> | null = null;
  const store = () => (db ??= d.open());
  let current: Session | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0, failed = false, applying = false, persisted = false, guarded = false;

  const dirty = (s: Session | null) => !!s && (s.tiles.size > 0 || s.record || s.clear || s.file !== null);
  const guard = (e: Event) => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ""; };
  /** The beforeunload guard is on iff something is dirty, a save is in flight, or the last save failed. */
  function sync(): void {
    const on = dirty(current) || inFlight > 0 || failed;
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
    if (!s.ready || !dirty(s)) return null;
    const store = labels.store(), base = labels.base(), view = labels.view();
    const tiles = [...s.tiles].map((k): [string, ArrayBuffer | null] => [k, store.tiles.get(k)?.slice().buffer ?? null]);
    const record = {
      key: s.key, name: s.name, classes: labels.classes().map((c) => ({ ...c })), selected: labels.selected(), ...view,
      base: base && { lut: base.lut.slice(), count: base.count, windows: [...base.windows], values: base.preview.values.slice() },
    };
    const snap = { s, tiles, clear: s.clear, file: s.file, record, labelled: labels.hasLabels() };
    s.tiles = new Set(); s.record = false; s.clear = false; s.file = null;
    return snap;
  }

  async function write(p: Snapshot): Promise<void> {
    const sessions = await store();
    if (!persisted) { persisted = true; d.persistStorage?.(); }
    if (!p.labelled) {
      // no labels left: nothing to offer back, so a session saved from this page goes
      if (p.s.owned) { await sessions.delete(p.s.key); p.s.owned = false; }
      return;
    }
    if (p.clear) await sessions.clearTiles(p.s.key); // a replace's old tiles go before its new ones are written
    if (p.file) await sessions.saveBase(p.s.key, p.file);
    for (const b of batches(p.tiles.map(([k]) => k), TILE_BATCH)) {
      const set = new Set(b);
      await sessions.putTiles(p.s.key, p.tiles.filter(([k]) => set.has(k)));
      await yieldTask();
    }
    await sessions.putRecord({ ...p.record, savedAt: now() }); // last: a record's tiles are all written
    p.s.owned = true;
    for (const k of evict(await sessions.list(), MAX_SESSIONS)) await sessions.delete(k);
  }

  /** Starts a save of the current session's changes; force: a hidden or closing tab, which doesn't wait for a stroke. */
  function save(force: boolean): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!current) return;
    if (!force && labels.stroking()) { schedule(); return; }
    const snap = take(current);
    if (snap) enqueue(snap);
  }

  function enqueue(snap: Snapshot): void {
    inFlight++;
    state.textContent = "Saving…";
    sync();
    chain = chain.then(() => write(snap)).then(() => {
      failed = false;
      if (inFlight === 1) state.textContent = `Saved ${time(now())}`;
    }, (e: unknown) => {
      failed = true;
      state.textContent = `Not saved: ${reasonOf(e)}`;
      // what it held is dirty again, for the next save
      const { s } = snap;
      for (const [k] of snap.tiles) s.tiles.add(k);
      s.record = true; s.clear ||= snap.clear; s.file ??= snap.file;
      if (s === current) schedule(); // tried again after the next delay
    }).finally(() => { inFlight--; sync(); });
  }

  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") save(true); });
  win.addEventListener("pagehide", () => save(true));

  return {
    /** A raster opens (before the labels switch to it): the old one's changes are copied and saved now, and the new one waits for offer(). */
    open(name: string, size: number, grid: Grid): void {
      if (current) save(true);
      current = { key: rasterKey(size, grid), name, grid, ready: false, owned: false, tiles: new Set(), record: false, clear: false, file: null };
      sync();
    },
    /** Once the preview is drawn: offers a saved session back. Resolves with the message to show, or null for none. */
    async offer(): Promise<string | null> {
      const s = current;
      if (!s || s.ready) return null;
      try {
        const sessions = await store();
        const r = await sessions.get(s.key);
        if (s !== current) return null;
        if (!r) return null;
        if (!d.confirm(MESSAGES.restore(dateTime(r.savedAt), r.name))) { await sessions.delete(s.key); return null; }
        const tiles = new Map<string, Uint8Array>();
        for (let after: string | null = null; ;) {
          const batch = await sessions.tiles(s.key, after, TILE_BATCH);
          for (const [k, buf] of batch) tiles.set(k, new Uint8Array(buf));
          if (batch.length < TILE_BATCH) break;
          after = batch[batch.length - 1]![0];
        }
        let base: MaskBase | null = null, missing = false;
        if (r.base) {
          try {
            const blob = await sessions.base(s.key);
            if (!blob) throw new Error("no mask copy");
            const file = await (d.openBase ?? openLabelFile)(blob);
            base = { file, lut: r.base.lut, count: r.base.count, windows: new Set(r.base.windows), preview: restoredPreview(s.grid, r.base.values) };
          } catch { missing = true; }
        }
        if (s !== current) return null;
        applying = true;
        try {
          labels.restore({ width: s.grid.width, height: s.grid.height, tiles, base: base !== null }, r.classes, base, r.selected, { opacity: r.opacity, visible: r.visible });
        } finally { applying = false; }
        s.owned = true;
        if (missing) s.record = true; // saved again without the mask
        return missing ? MESSAGES.restoredNoMask : MESSAGES.restored;
      } finally {
        if (s === current) { s.ready = true; if (dirty(s)) schedule(); sync(); }
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
      changed();
    },
    /** The saves started so far have ended (tests). */
    idle: () => chain,
  };
}
