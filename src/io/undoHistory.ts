import { emptyBoxes, type BoxStore } from "../core/boxes";
import type { Window } from "../core/grid";
import type { LabelStore } from "../core/labelStore";
import {
  UNDO_BYTES, UNDO_STEPS, entryBytes, finishBoxes, finishEdit, recordBoxes, recordTiles, swapBoxes, swapEdit, trimHistory,
  type BoxEdit, type Edit, type Entry,
} from "../core/undo";

/** One edit while it can still change: in progress, or ended with cells still queued. boxes: box before-states (spec 063). */
export type StrokeEdit = { edit: Edit; boxes: BoxEdit; queued: number; ended: boolean };

/** What an undo or redo changed: tile keys row-major, box ids ascending. */
export type Changed = { tiles: string[]; boxes: number[] };

/** Label undo and redo (specs 010, 037, 048, 063, ADRs 0015, 0038): one entry per stroke or box edit, appended once it has ended and its last cell applied. */
// Strokes finish in the order they started (one stroke at a time, applied first in first out), so
// entries stay in stroke order even when a stroke's cells wait for masks.
export class UndoHistory {
  private history: Entry[] = [];
  /** Inverses of undone entries, newest last; an entry that changes a tile or a box empties it. */
  private redoStack: Entry[] = [];
  private open: StrokeEdit[] = [];

  /** boxes defaults to a store of its own, for callers without boxes. */
  constructor(private readonly store: () => LabelStore, private readonly boxes: () => BoxStore = ((b) => () => b)(emptyBoxes())) {}

  /** Undoable entries. */
  get size(): number { return this.history.length; }

  /** Redoable entries. */
  get redoSize(): number { return this.redoStack.length; }

  /** The entries, oldest first (for tests). */
  entries(): readonly Entry[] { return this.history; }

  /** Bytes held (entryBytes): history, redo stack and unfinished strokes. */
  bytes(): number { return this.openBytes() + [...this.history, ...this.redoStack].reduce((n, e) => n + entryBytes(e), 0); }

  begin(): StrokeEdit {
    const s: StrokeEdit = { edit: new Map(), boxes: new Map(), queued: 0, ended: false };
    this.open.push(s);
    return s;
  }

  /** The stroke's press ended; it is appended once its queued cells have applied. */
  end(s: StrokeEdit): void {
    s.ended = true;
    this.settle(s);
  }

  /** A cell of s entered the paint queue. */
  queued(s: StrokeEdit): void { s.queued++; }

  /** Called before a move of s is brushed, with its window or tile keys; older entries make room so the stroke's own copies are kept. */
  record(s: StrokeEdit, w: Window | string[]): void {
    const n = s.edit.size;
    recordTiles(this.store(), s.edit, w);
    if (s.edit.size > n) this.trim(UNDO_BYTES - this.openBytes());
  }

  /** Called before s changes these boxes; to add one, pass the store's next id. */
  recordBoxes(s: StrokeEdit, ids: number[]): void {
    const n = s.boxes.size;
    recordBoxes(this.boxes(), s.boxes, ids);
    if (s.boxes.size > n) this.trim(UNDO_BYTES - this.openBytes());
  }

  /** A cell of s applied (or was dropped). */
  applied(s: StrokeEdit): void {
    s.queued--;
    this.settle(s);
  }

  /** The paint queue dropped its cells (a failed read): what applied so far stays undoable. */
  dropQueued(): void {
    for (const s of [...this.open]) { s.queued = 0; this.settle(s); }
  }

  /** Reverts the newest entry and keeps its inverse for redo; returns what it changed, or null when there is none. */
  undo(): Changed | null { return this.swap(this.history, this.redoStack); }

  /** Reapplies the newest undone entry and keeps its inverse for undo; returns what it changed, or null when there is none. */
  redo(): Changed | null { return this.swap(this.redoStack, this.history); }

  /** Forget everything (the store was replaced). */
  clear(): void {
    this.history = [];
    this.redoStack = [];
    for (const s of this.open) { s.edit = new Map(); s.boxes = new Map(); }
    this.open = [];
  }

  private swap(from: Entry[], to: Entry[]): Changed | null {
    const e = from.pop();
    if (!e) return null;
    const tiles = swapEdit(this.store(), e.tiles), boxes = swapBoxes(this.boxes(), e.boxes);
    const inverse: Entry = { tiles: tiles.inverse, boxes: boxes.inverse };
    to.push(inverse);
    this.trim(UNDO_BYTES - this.openBytes(), inverse); // the inverse may hold more bytes than the entry did
    return { tiles: tiles.keys, boxes: boxes.ids };
  }

  /** keep: the entry just appended or pushed, kept even when it alone is over the budget (spec 048). */
  private trim(maxBytes: number, keep?: Entry): void { trimHistory(this.history, maxBytes, UNDO_STEPS, this.redoStack, keep); }

  private openBytes(): number { return this.open.reduce((n, s) => n + entryBytes({ tiles: s.edit, boxes: s.boxes }), 0); }

  private settle(s: StrokeEdit): void {
    if (!s.ended || s.queued > 0) return;
    const i = this.open.indexOf(s);
    if (i < 0) return; // cleared meanwhile
    this.open.splice(i, 1);
    const tiles = finishEdit(this.store(), s.edit), boxes = finishBoxes(this.boxes(), s.boxes);
    if (!tiles && !boxes) return;
    const done: Entry = { tiles: tiles ?? new Map(), boxes: boxes ?? new Map() };
    this.history.push(done);
    this.redoStack = [];
    this.trim(UNDO_BYTES - this.openBytes(), done);
  }
}
