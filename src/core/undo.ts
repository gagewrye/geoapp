import type { Window } from "./grid";
import { tileKeys, type LabelStore } from "./labelStore";

/** History, redo stack and unfinished strokes stay within this many bytes of tile copies (ADR 0015, spec 037). */
export const UNDO_BYTES = 32 * 1024 * 1024;
export const UNDO_STEPS = 50;

/** LabelStore key -> a copy of the tile before the stroke; null = no tile then. */
export type Edit = Map<string, Uint8Array | null>;

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

/** Puts each tile back (null deletes it); returns the keys, row-major. */
export const undoEdit = (store: LabelStore, edit: Edit): string[] => swapEdit(store, edit).keys;

/** Sum of the copies' lengths. */
export function editBytes(edit: Edit): number {
  let n = 0;
  for (const t of edit.values()) n += t?.length ?? 0;
  return n;
}

/**
 * Drops entries until both stacks' editBytes <= maxBytes and their lengths <= maxSteps: the redo stack's
 * oldest-undone first (redo[0], the last to be redone), then the history's oldest.
 */
export function trimHistory(history: Edit[], maxBytes: number, maxSteps: number, redo: Edit[] = []): void {
  let total = [...history, ...redo].reduce((n, e) => n + editBytes(e), 0);
  const over = () => history.length + redo.length > maxSteps || total > maxBytes;
  while (redo.length && over()) total -= editBytes(redo.shift()!);
  while (history.length && over()) total -= editBytes(history.shift()!);
}
