import { removeBox, setBox, type Box, type BoxStore } from "./boxes";
import type { Window } from "./grid";
import { tileKeys, type LabelStore } from "./labelStore";

/** History, redo stack and unfinished strokes stay within this many bytes of copies (ADR 0015, spec 037, ADR 0038). */
export const UNDO_BYTES = 32 * 1024 * 1024;
export const UNDO_STEPS = 50;
/** What one box before-state counts against UNDO_BYTES (ADR 0038). */
export const BOX_BYTES = 48;

/** LabelStore key -> a copy of the tile before the stroke; null = no tile then. */
export type Edit = Map<string, Uint8Array | null>;

/** Box id -> a copy of the box before the edit; null = no box then. */
export type BoxEdit = Map<number, Box | null>;

/** One undo step: tile copies and box before-states (ADR 0038). */
export type Entry = { tiles: Edit; boxes: BoxEdit };

/** Adds a copy (or null) for each key of tileKeys(w), or of the keys given, not yet in edit. */
export function recordTiles(store: LabelStore, edit: Edit, w: Window | string[]): void {
  for (const key of Array.isArray(w) ? w : tileKeys(w)) if (!edit.has(key)) edit.set(key, store.tiles.get(key)?.slice() ?? null);
}

function same(a: Uint8Array | null, b: Uint8Array | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Drops keys whose tile is unchanged; null when nothing changed. */
export function finishEdit(store: LabelStore, edit: Edit): Edit | null {
  for (const [key, before] of edit) if (same(before, store.tiles.get(key))) edit.delete(key);
  return edit.size ? edit : null;
}

const rowMajor = (a: string, b: string) => {
  const [ax, ay] = a.split(",").map(Number) as [number, number];
  const [bx, by] = b.split(",").map(Number) as [number, number];
  return ay - by || ax - bx;
};

/** Puts each tile back (null deletes it); returns copies of what it replaced (the inverse) and the keys, row-major. */
export function swapEdit(store: LabelStore, edit: Edit): { inverse: Edit; keys: string[] } {
  const inverse: Edit = new Map();
  for (const [key, before] of edit) {
    inverse.set(key, store.tiles.get(key)?.slice() ?? null);
    if (before) store.tiles.set(key, before);
    else store.tiles.delete(key);
  }
  return { inverse, keys: [...edit.keys()].sort(rowMajor) };
}

/** Sum of the copies' lengths. */
export function editBytes(edit: Edit): number {
  let n = 0;
  for (const t of edit.values()) n += t?.length ?? 0;
  return n;
}

/** Adds a copy (or null) for each id not yet in edit; to add a box, record s.next first. */
export function recordBoxes(s: BoxStore, edit: BoxEdit, ids: number[]): void {
  for (const id of ids) if (!edit.has(id)) { const b = s.boxes.get(id); edit.set(id, b ? { ...b } : null); }
}

function sameBox(a: Box | null, b: Box | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.value === b.value && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/** Drops ids whose box is unchanged; null when nothing changed. */
export function finishBoxes(s: BoxStore, edit: BoxEdit): BoxEdit | null {
  for (const [id, before] of edit) if (sameBox(before, s.boxes.get(id))) edit.delete(id);
  return edit.size ? edit : null;
}

/** Puts each box back (null removes it); returns copies of what it replaced (the inverse) and the ids, ascending. */
export function swapBoxes(s: BoxStore, edit: BoxEdit): { inverse: BoxEdit; ids: number[] } {
  const inverse: BoxEdit = new Map();
  for (const [id, before] of edit) {
    const now = s.boxes.get(id);
    inverse.set(id, now ? { ...now } : null);
    if (before) setBox(s, before);
    else removeBox(s, id);
  }
  return { inverse, ids: [...edit.keys()].sort((a, b) => a - b) };
}

/** editBytes of the tiles plus BOX_BYTES per box before-state. */
export function entryBytes(e: Entry): number { return editBytes(e.tiles) + BOX_BYTES * e.boxes.size; }

/**
 * Drops entries until both stacks' entryBytes <= maxBytes and their lengths <= maxSteps: the redo stack's
 * oldest-undone first (redo[0], the last to be redone), then the history's oldest. keep, the entry just
 * appended or pushed, is never dropped, so one edit over maxBytes stays undoable alone (spec 048).
 */
export function trimHistory(history: Entry[], maxBytes: number, maxSteps: number, redo: Entry[] = [], keep?: Entry): void {
  let total = [...history, ...redo].reduce((n, e) => n + entryBytes(e), 0);
  const over = () => history.length + redo.length > maxSteps || total > maxBytes;
  for (const stack of [redo, history]) {
    for (let i = 0; i < stack.length && over();) {
      if (stack[i] === keep) i++;
      else total -= entryBytes(stack.splice(i, 1)[0]!);
    }
  }
}
