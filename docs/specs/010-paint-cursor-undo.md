# 010: Brush cursor and undo

**Goal:** Show a paintbrush cursor in the selected class colour while painting, and let the user undo their latest strokes with a button or Ctrl+Z.

**Status:** Approved (Gage, 2026-10-27; undo cap raised to 32 MiB, 50 steps kept; no redo; class edits not undoable). **ADRs:** 0015 undo history (Accepted). Amends spec 003 (undo was out of scope). The spec 004 clauses (marked) take effect when spec 004 is built; until then they are not implemented or tested.

## Scope
In: the brush cursor; an "Undo" button in the brush panel; Ctrl+Z / Cmd+Z; multi-step undo of paint and erase strokes.
Out: redo; undoing class edits, imports, seeding or a raster open; persisting history; a custom cursor for Pan mode.

## Interfaces (`core/`)
```ts
const UNDO_BYTES = 32 * 1024 * 1024; // history + the stroke in progress (ADR 0015)
const UNDO_STEPS = 50;
type Edit = Map<string, Uint8Array | null>;     // LabelStore key -> the tile before the stroke (a copy); null = no tile then
recordTiles(store: LabelStore, edit: Edit, w: Window): void // adds a copy (or null) for each key of tileKeys(w) not yet in edit
finishEdit(store: LabelStore, edit: Edit): Edit | null      // drops keys whose tile is unchanged; null when nothing changed
undoEdit(store: LabelStore, edit: Edit): string[]           // puts each tile back (null deletes it); returns the keys, row-major
editBytes(edit: Edit): number                               // sum of the copies' lengths
trimHistory(history: Edit[], maxBytes: number, maxSteps: number): void // drops oldest until total editBytes <= maxBytes and length <= maxSteps
```

**Rules.**
- **Cursor.** While spec 003 Paint applies (local imagery open, Paint mode, Space not held, area tool off, no middle pan), the map canvas shows a 32x32 SVG paintbrush cursor as a `data:` URL whose bristles are filled with the selected class colour and outlined in black and white for contrast, hotspot at the bristle tip, fallback `crosshair`. It updates at once on select (click or `1`-`9`) and recolour. Otherwise MapLibre's and terra-draw's cursors apply. The footprint ring stays (spec 003 Hover).
- **What an edit is.** One stroke, from its press to its end, including cells that apply later from spec 003's paint queue. Before each cell's `brush`, `io/` calls `recordTiles` with its footprint. After each `recordTiles` that adds a copy, `trimHistory(history, UNDO_BYTES - editBytes(current), UNDO_STEPS)` runs, so history plus the stroke in progress stay within `UNDO_BYTES`; the stroke's own copies are never dropped (a stroke copies only tiles stored when it meets them: at most 256, 16 MiB). When the stroke has ended and its last cell applied, a non-null `finishEdit` result is appended and `trimHistory(history, UNDO_BYTES, UNDO_STEPS)` runs.
- **Undo** reverts the most recent entry: `undoEdit`, then `keepMasks(store, masks, null)`, then the returned tiles' overlays are redrawn. Undo is enabled only when the history is non-empty, no stroke is in progress and the paint queue is empty; *(with spec 004)* also only while no import or seeding runs. Ctrl+Z (Cmd+Z on macOS) does the same, except in a text field, where the field's native undo applies.
- **Clearing.** `ui/labels.ts`'s returned object gains `clearHistory(): void`, which empties the history and updates the Undo button. Opening a raster calls it. *(With spec 004)* a successful Import labels or Seed, which replace the store, call it too; spec 004's implementer wires this. Train only reads the store and keeps the history. Writes through spec 003's e2e hook bypass the history, so tests of undo paint with the mouse.
- **Cap.** Undo restores an earlier state of the store, so it never exceeds `MAX_LABEL_TILES`.

## Acceptance criteria
1. `recordTiles`/`finishEdit`/`undoEdit` (unit): over a 2x2-tile store, record, paint a size-7 dab across the corner, finish, undo: every tile is byte-equal to before, a tile created by the dab is gone, and the returned keys are the 4 met, row-major. A stroke that changes nothing (only nodata, or erasing an absent class) gives `finishEdit` null. Recording a key twice keeps the first copy.
2. `trimHistory` (unit): 51 one-tile edits trimmed with `UNDO_STEPS` keep the newest 50. Nine 4 MiB edits trimmed with `UNDO_BYTES` keep the newest 8. `editBytes` counts null entries as 0.
3. Undo (e2e, EPSG:4326 fixture): paint stroke A in class 1, stroke B in class 2 over part of A, erase stroke C over part of B. Undo three times: after each, the store equals the snapshot taken before that stroke, overlays match the store (spec 003 criterion 6's colours), and the button is disabled after the third. Ctrl+Z does the same; Ctrl+Z typed in a class name field undoes the text, not a stroke.
4. Undo and the queue (e2e, imagery source paused): during and after a stroke whose cells wait for masks, Undo is disabled; after reads resume and the cells apply, one Undo removes the whole stroke.
5. Clearing (e2e): after a stroke, opening another raster (OK on the confirm) leaves Undo disabled; Train leaves it enabled and the history unchanged. *(With spec 004, added to its tests then)*: a successful Import labels or Seed leaves Undo disabled, and Undo is disabled while either runs.
6. Memory (unit): with `MAX_LABEL_TILES` tiles stored and a history of 24 one-MiB edits, a stroke recording all 256 tiles (16 MiB) drops the oldest 8 edits, keeps the newest 16, keeps its own entry whole, and the total of `editBytes` never exceeds `UNDO_BYTES`.
7. Cursor (e2e): in Paint mode the computed `cursor` of the element under a point on the map (`elementFromPoint`) starts with `url("data:image/svg+xml` and, URI-decoded, contains the selected colour (`#rrggbb`, case-insensitive) and ends with `crosshair`. After key `2`, and after recolouring the selected class, it contains the new colour. In Pan mode, with Space held, with no imagery open, and over the panel, it doesn't start with `url(`.
