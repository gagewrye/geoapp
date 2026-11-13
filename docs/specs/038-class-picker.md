# 038: Class picker

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none. **Builds on specs 014, 032 and 033.** Amended after implementation (2026-10-30): a failed mask read (scope 3, criterion 3).

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): unit `core/pick`'s check that no file names the removed undo helper (criterion 7).

**Goal:** Alt+click on a labelled pixel, or `I` while hovering one, selects its class.

## Scope
1. An Alt+left press on the raster, in any mode, picks instead of painting or panning. The press is stopped before MapLibre and the brush see it, and no stroke starts.
2. `I` picks at the last pointer position over the map. It is ignored in text fields, with Ctrl/Meta/Alt held, before open, or while the pointer is off the raster.
3. **Picking.** The pixel's effective label comes from `labels.tile(key)`: the stored tile, else the mask's tile, read on demand.
   - A value v > 0 selects class v − 1 and says `Picked <name>.` (info).
   - A value of 0 says `No label here.` (info) and keeps the selection.
   - A pick that is still reading when another starts is dropped.
   - A failed tile read says `errorText(e)` (error) through `say`, and keeps the selection and the mode.
4. The mode is unchanged by a pick.
5. Holding Alt by itself does nothing. The Alt keyup is `preventDefault`ed while the pointer is over the map, so Firefox's menu bar doesn't take focus.

6. **Carried from spec 037's review** (non-blocking there): `undoEdit` in `core/undo.ts` now copies every tile through `swapEdit` and throws the copies away, and only tests call it. Delete it, and move its tests in `tests/unit/core/undo.test.ts` and `undo.tester.test.ts` to `swapEdit(...).keys`. This replaces spec 037's "`undoEdit` becomes `swapEdit(...).keys`".

**Out of scope:** picking from imagery values, swapping with the last class.

## Interfaces
- `core/pick.ts`: `labelAt(tile: Uint8Array, w: Window, col: number, row: number): number`. It reads row-major within w, and throws `RangeError` when (col, row) is outside w.
- `map/brush.ts`:
  - gains a `pick: (cell: [number, number]) => void` dep, called on an Alt+left press over a raster cell;
  - gains `hoverCell(): [number, number] | null` for `I`.
- `ui/labels.ts` wires `pick` to `tile()`, `labelAt` and `select`.

## Acceptance criteria
1. **Unit (core):**
   - `labelAt` returns the right value at all four corners of a 3×2 window with origin (256, 512).
   - It throws for a cell outside the window.
2. **Unit (brush):**
   - In Paint, Erase and Pan modes, an Alt+left press calls `pick` with its cell and starts no stroke.
   - In Pan mode, MapLibre gets no `mousedown`.
3. **Unit (labels, fake tile):**
   - A pick of value 3 selects index 2 and says `Picked <class 3 name>.`
   - A pick of value 0 keeps the selection and says `No label here.`
   - Of two overlapping picks, only the second applies.
   - A pick whose `tile()` rejects says `errorText` of the error as an error, leaves the selection and mode unchanged, and leaves no unhandled rejection.
4. **E2E:**
   - Paint class 2. Select class 1, then Alt+click the painted pixel: class 2 is selected and the tile is unchanged.
   - Hover the pixel and press `I` with class 1 selected: the same result.
5. **E2E:** after importing the fixture mask, Alt+click on a mask-only pixel of class 3 selects class 3.
6. `npm run check` passes.
7. **Scope 6:**
   - no file under `src/` or `tests/` names `undoEdit`;
   - the moved tests expect the same keys as before, and the undo history's tests pass unchanged.
