# 063: Box model, store and one undo history

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** 0038 (Accepted: one undo history; amends ADR 0015). **Builds on specs 010, 037 and 048.** It is part of the series in spec 062. It adds no UI.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): unit `core/boxes.tester` (criteria 1–5), `io/undoHistory.boxes.tester` (6–8) and `ui/labels.boxes.tester` (scope 6). The base `core/boxes`, `io/undoHistory.boxes` and `ui/labels` tests stay.

## Decided (Gage, 2026-11-12: the recommended answers)
1. **One undo history** for masks and boxes (ADR 0038), not a separate box history.
2. **Integer pixel edges.** Boxes snap to whole pixels, as every mask label does. Sub-pixel boxes would need float edges and gain little at native resolution.

**Goal:** Axis-aligned boxes exist as pure data in raster pixels, and their edits share one undo and redo history with mask tiles.

## Scope
1. **Box.** `{ id, value, x0, y0, x1, y1 }`, all integers:
   - `x0`, `y0`, `x1` and `y1` are pixel edges, with `0 ≤ x0 < x1 ≤ width` and `0 ≤ y0 < y1 ≤ height`. The box covers pixels `x0..x1−1` and `y0..y1−1`.
   - `value` is the class index + 1 (1..255), as in tiles. So classes are shared, and a class edit recolours its boxes.
   - `id` is positive and is never reused while a raster is open.
2. **Store.** `BoxStore = { boxes: Map<number, Box>; next: number }`, iterated in insertion order. Opening a raster gives an empty store. `addBox`, `setBox` (replace by id) and `removeBox` are its only edits.
3. **Geometry (pure).** A pixel is `[col, row]`, as `pixelAt` returns.
   - `rectFrom(a, b, dims)` gives the box covering pixels `a` and `b` inclusive, in either order, clipped to the raster. It returns null when the box lies wholly outside.
   - `moveRect(r, dx, dy, dims)` keeps the size and is clamped inside the raster.
   - `resizeRect(r, handle, cell, dims)` moves the handle's edges to cover `cell`.
     - Dragging an edge past the opposite edge flips the box.
     - The result is at least 1 × 1 px and is clipped to the raster.
   - `boxesAt(store, col, row)` gives the boxes that contain the pixel, smallest area first, and newest first on a tie.
   - `handlePoints(r)` gives the 8 handles (`nw n ne e se s sw w`) as pixel-edge points.
4. **Undo (ADR 0038).**
   - A history entry is `{ tiles: Edit; boxes: BoxEdit }`. `BoxEdit = Map<id, Box | null>` holds before-states, where null means the box didn't exist.
   - `recordBoxes` copies the before-state of ids not yet recorded.
   - When an entry ends, unchanged boxes are dropped. An entry that changed no tile and no box isn't appended.
   - `swapBoxes` puts the before-states back and returns the inverse.
   - `entryBytes` = `editBytes(tiles)` + `BOX_BYTES` (48) × `boxes.size`. Spec 037's trimming and spec 048's keep rule apply to whole entries.
5. **`UndoHistory`** takes `(store, boxes)` getters and gains `recordBoxes(s: StrokeEdit, ids: number[])`.
   - `undo()` and `redo()` return `{ tiles: string[]; boxes: number[] } | null`. Tile keys are row-major as before, and box ids ascend.
   - Any appended entry that changed a tile or a box clears redo (spec 037 scope 3).
   - `ui/undo.ts`'s `undone` receives that object. `ui/labels.ts` redraws its tiles as today, and its box redraw stays a no-op until spec 064.
6. `ui/labels.ts` holds the `BoxStore`. `open()` empties it. `replace()` keeps it, but clears its history entries along with the tile entries, as today.

**Out of scope:** drawing, display, the list, persistence, export, rotated boxes, box attributes beyond class.

## Interfaces
- `core/boxes.ts` (pure):
  - `type Rect = { x0: number; y0: number; x1: number; y1: number }`, `type Box = Rect & { id: number; value: number }`;
  - `type BoxStore`, `emptyBoxes(): BoxStore`;
  - `addBox(s, r: Rect, value): Box` (throws for a value outside 1..255 or an empty rect), `setBox(s, b): void`, `removeBox(s, id): void`;
  - `type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"`;
  - `rectFrom`, `moveRect`, `resizeRect`, `boxesAt` and `handlePoints` as in scope 3.
- `core/undo.ts`: `BoxEdit`, `BOX_BYTES`, `type Entry = { tiles: Edit; boxes: BoxEdit }`, `recordBoxes`, `finishBoxes`, `swapBoxes` and `entryBytes`. `trimHistory` takes `Entry[]`. `swapEdit` keeps its signature.
- `io/undoHistory.ts` as in scope 5.

## Acceptance criteria
1. **Unit (rectFrom):**
   - Both corner orders give the same box, and both pixels are inside.
   - A box crossing the raster edge is clipped. One wholly outside gives null.
2. **Unit (moveRect, 500 random rects and moves on 300 × 200):** the size is kept and the result lies inside the raster. A move within bounds is exact.
3. **Unit (resizeRect):**
   - Each of the 8 handles moves only its own edges.
   - Crossing the opposite edge flips the box.
   - A 1 px box stays at least 1 px, and the result is clipped.
4. **Unit (boxesAt):**
   - Nested boxes come smallest first.
   - Pixel `x1 − 1` is inside and `x1` is outside.
   - A tie gives the newer box first.
5. **Unit (store):**
   - Ids increase and are not reused after a remove.
   - `addBox` throws for value 0 or 256, and for an empty rect.
6. **Unit (UndoHistory):**
   - Add, move, then remove a box as 3 entries. 3 undos leave the store deep-equal to empty, and 3 redos restore it.
   - Mixed: stroke A, add a box, stroke B. Undos revert B, then the box, then A. Each return names only what it changed.
7. **Unit:**
   - A move by (0, 0) appends no entry.
   - After an undo, a new box entry empties redo.
8. **Unit (budget):**
   - An entry of 3 box changes counts 144 bytes.
   - 51 box entries keep the newest 50.
   - Spec 037 criterion 4 and spec 048's keep rule hold with mixed entries.
9. The spec 010, 037 and 048 unit and e2e tests pass. They are edited only for the new `undo()` and `redo()` return type, and no assertion is weakened.
10. `npm run check` passes.
11. **Docs:**
    - ADR 0015's Status names ADR 0038.
    - CLAUDE.md's `core/` line should gain "boxes". Only Gage edits CLAUDE.md.
