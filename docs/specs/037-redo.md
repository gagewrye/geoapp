# 037: Redo

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none; this extends ADR 0015 within its 32 MiB and 50-step budget. **Builds on spec 010.** Amended by spec 048 (2026-11-01): trimming never drops the entry just appended or pushed (scope 4), so one edit over `UNDO_BYTES` stays undoable and redoable alone; criterion 4's bound becomes max(`UNDO_BYTES`, that edit's copies).

**Amended by spec 057 (2026-11-11):** criterion 9 no longer requires the README to name "**Redo**"; Gage shortened the README. The check that it has no "shows the labels again, and the opacity slider" stands.

**Goal:** An undone stroke can be redone with Ctrl+Shift+Z, Ctrl+Y or a Redo button.

## Scope
1. Undo reverts the newest entry as now, and pushes that entry's inverse (copies of the tiles as they were just before the undo) onto a redo stack.
2. Redo pops the newest redo entry, applies it, and pushes its inverse back onto the history.
3. Any new stroke that changes a tile clears the redo stack when it is appended (`settle`). So do `clear()` (open or replace) and a restore (spec 031).
4. **Budget.** History, redo stack and unfinished strokes together stay within `UNDO_BYTES` and `UNDO_STEPS`. Trimming drops the redo stack's oldest-undone entries first, then the history's oldest.
5. Redo is blocked exactly when undo is: locked, stroking, or cells queued.
   - The `#redo` button is beside `#undo` and disabled when it is blocked or the stack is empty.
   - Keys: Ctrl/Cmd+Shift+Z and Ctrl+Y, ignored in text fields like Ctrl+Z.
6. Redone tiles redraw and mark tiles dirty for spec 031, as undone ones do.

7. **Carried from spec 036's review** (non-blocking there):
   - `ownsHome` in `ui/main.ts` returns true only for text fields, `select`, and `range` or `number` inputs. A focused checkbox or file input no longer blocks the map's Home;
   - the README sentence "…shows the labels again, and the opacity slider beside it sets…" is split after "shows the labels again". Both strings that `tests/unit/ui/style.test.ts` checks stay;
   - `tests/unit/ui/classList.test.ts`'s Enter test checks propagation the way its Escape test does, with an ancestor listener that must not be called, instead of the fake event's `stopped` flag.

**Out of scope:** a history panel, redo across a reload.

## Interfaces
- `core/undo.ts`: `swapEdit(store: LabelStore, edit: Edit): { inverse: Edit; keys: string[] }` puts each tile back (null deletes) and returns copies of what it replaced, with the keys row-major. `undoEdit` becomes `swapEdit(...).keys`.
- `io/undoHistory.ts` `UndoHistory`:
  - gains `redo(): string[] | null`, `redoSize: number` and `bytes()`, which now include the redo stack;
  - `trimHistory` is applied to the combined budget.
- `ui/undo.ts` wires the button and keys.

## Acceptance criteria
1. **Unit (core):**
   - `swapEdit(store, e)` then `swapEdit(store, inverse)` leaves the store byte-equal to the start, including tiles that were absent.
   - The keys are row-major.
2. **Unit (history):**
   - Strokes A, B, then undo, undo, redo leaves the store equal to after A.
   - A second redo leaves it equal to after B.
   - A third redo returns null.
3. **Unit:** after undo, a new stroke C that changes a tile empties the redo stack. A click that changes no tile does not.
4. **Unit:** with entries filling `UNDO_BYTES`, an undo followed by a large stroke keeps `bytes()` ≤ `UNDO_BYTES`, and redo entries are dropped before history entries.
5. **Unit (keys):** Ctrl+Shift+Z, Meta+Shift+Z and Ctrl+Y call redo. None of them does in a text field, or while blocked.
6. **E2E:** paint 3 strokes, undo 3 times, then redo 3 times: the export is byte-equal to one made after the 3 strokes. `#redo` is disabled at the end.
7. Spec 010's criteria pass. `npm run check` passes.
8. **E2E (scope 7):** after open, pan and zoom away, focus `#show-labels` and press `Home`: the map bounds equal those right after open, to 1e-6°. Spec 036's focused-slider Home step still passes.
9. **Scope 7:**
   - `style.test.ts` passes unchanged, and `README.md` no longer contains "shows the labels again, and the opacity slider";
   - `classList.test.ts` no longer reads `stopped`, and its Enter test fails if the input's Enter handler stops calling `stopPropagation`.
