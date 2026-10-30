import type { Window } from "../core/grid";
import type { LabelStore } from "../core/labelStore";
import { UNDO_BYTES, UNDO_STEPS, editBytes, finishEdit, recordTiles, trimHistory, undoEdit, type Edit } from "../core/undo";

/** One stroke's edit while it can still change: in progress, or ended with cells still queued. */
export type StrokeEdit = { edit: Edit; queued: number; ended: boolean };

/** Paint undo (spec 010, ADR 0015): one entry per stroke, appended once it has ended and its last cell applied. */
// Strokes finish in the order they started (one stroke at a time, applied first in first out), so
// entries stay in stroke order even when a stroke's cells wait for masks.
export class UndoHistory {
  private history: Edit[] = [];
  private open: StrokeEdit[] = [];

  constructor(private readonly store: () => LabelStore) {}

  /** Undoable strokes. */
  get size(): number { return this.history.length; }

  /** The entries, oldest first (for tests). */
  entries(): readonly Edit[] { return this.history; }

  /** Bytes of tile copies held: history plus unfinished strokes. */
  bytes(): number { return this.openBytes() + this.history.reduce((n, e) => n + editBytes(e), 0); }

  begin(): StrokeEdit {
    const s: StrokeEdit = { edit: new Map(), queued: 0, ended: false };
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
    if (s.edit.size > n) trimHistory(this.history, UNDO_BYTES - this.openBytes(), UNDO_STEPS);
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

  /** Reverts the newest entry; returns its keys row-major, or null when there is none. */
  undo(): string[] | null {
    const e = this.history.pop();
    return e ? undoEdit(this.store(), e) : null;
  }

  /** Forget everything (the store was replaced). */
  clear(): void {
    this.history = [];
    for (const s of this.open) s.edit = new Map();
    this.open = [];
  }

  private openBytes(): number { return this.open.reduce((n, s) => n + editBytes(s.edit), 0); }

  private settle(s: StrokeEdit): void {
    if (!s.ended || s.queued > 0) return;
    const i = this.open.indexOf(s);
    if (i < 0) return; // cleared meanwhile
    this.open.splice(i, 1);
    const done = finishEdit(this.store(), s.edit);
    if (!done) return;
    this.history.push(done);
    trimHistory(this.history, UNDO_BYTES, UNDO_STEPS);
  }
}
