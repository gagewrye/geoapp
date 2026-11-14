# 064: Box tool: draw, select, move, resize, delete and reclass boxes

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** none. There is no dependency: the tool is hand-written in `map/`, as the brush and polygon are (ADR 0009). terra-draw (ADR 0003) is shelved, and it edits rectangles in lon/lat, which aren't axis-aligned on a UTM raster. **Builds on specs 062 and 063, plus 004, 016, 019, 032, 034, 038 and 039.** It is part of the series in spec 062.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): unit `ui/labels.boxes.tester`, which named this spec in a title. Spec 064 is not built yet.

## Decided (Gage, 2026-11-12: the recommended answers)
1. **Key.** `R` for Box (`B` is Paint, and `R` is free). Delete or Backspace deletes the selected box.
2. **Changing a box's class.** With a box selected, choosing a class (1–9, or a click on its row) also gives that box the class, as one undo step.
3. **Import labels with boxes present.** An import replaces the masks and the class list. Boxes are kept with their values, and the list is extended with `Class v` for any box value beyond it.
4. **Show (H) and the peek** hide boxes as well as masks. Opacity stays for masks only.
5. **Reload.** Build spec 066 straight after this one. The repo has no deploy pipeline, so a merge deploys nothing, and 064 and 066 may merge separately.

   Users run the app from a clone of main (README), though. Anyone who pulls between the two merges gets boxes that a reload loses, which criterion 11's README note says.

**Goal:** In Box mode, a drag on the imagery draws an axis-aligned box in the selected class. The selected box can be moved, resized, deleted or given another class, and each edit is one undoable step.

## Scope
1. **Kind and mode.**
   - `KINDS` gains `box`: "Boxes", with mode `box`, group `#tools-box` holding `#mode-box` (▭, `Box (R)`), and no sections yet.
   - `#kinds` now shows the Masks and Boxes radios. In Boxes, the mask tools and `#brush-group` are hidden.
   - Box is disabled exactly when Paint is (spec 019). Choosing it shows hidden labels. Hiding labels selects Pan (spec 016).
2. **Pointer in Box mode (mouse and pen, left button, on the raster).**
   - Input:
     - As in Paint, drags don't pan. Drag rotate, double-click zoom and box zoom are off, and MapLibre never sees the mousedown.
     - Space held, a middle drag and WASD pan. Touch pans. Alt+click picks (spec 038).
     - A press and release within 4 px is a click. Anything longer is a drag.
   - A drag that starts within 6 screen px of a handle of the selected box resizes it. Corners win over edges.
   - A drag that starts inside the selected box moves it.
   - Any other drag draws a new box: `rectFrom` of the press pixel and the pointer's pixel, in the selected class. The new box becomes selected.
   - While dragging, the box shows in an edit layer. A release appends one undo entry, unless nothing changed. Escape during a drag cancels it. Positions off the raster clamp to its edge.
   - A click selects the first box of `boxesAt` the pixel. Another click on the same pixel selects the next one, so nested boxes can be reached. A click on no box clears the selection.
3. **Selection.**
   - At most one box is selected. The selection isn't undoable.
   - It is kept while the kind is Boxes. It is cleared when the kind becomes Masks, when a raster opens, or when its box goes (delete or undo).
   - Handles show and drags edit only in Box mode.
4. **Keys.**
   - Delete or Backspace deletes the selected box as one entry. Backspace still removes a polygon corner first.
   - Escape cancels a drag, else clears the selection. Otherwise it keeps its order after Smart and Polygon, then selects Pan.
   - With a box selected, choosing a class also sets that box's class, as one entry. Choosing its own class makes no entry.
   - All are blocked while the labels are locked (specs 004 and 031) and during a peek (spec 034).
5. **Display (`map/boxLayer.ts`, slot `boxes` between `label-` and `smart`).**
   - Each box is a ring of its pixel-edge corners (`footprintRing`): a 2 px class-colour line on a 4 px dark casing, with a class-colour fill at opacity 0.1.
   - The selected box has a 3 px line, and in Box mode 8 handles.
   - A recolour redraws.
   - Show (H) and the peek hide boxes and handles.
   - During a drag, only the edit source updates. The edited box is filtered out of the boxes source, which is set once on release.
6. **Lifecycle.**
   - `hasLabels()` counts boxes, so spec 032's question asks before another open discards them.
   - An import follows open question 3.
   - Undo, redo and their buttons cover box entries (spec 063), and a box undo redraws the box layer.
7. **Status and help.**
   - `#status-tool` shows `Box · <class>`, and `Box · <class> · <w>×<h> px` while a box is selected.
   - `SHORTCUTS` gains `R`, Drag (draw, move or resize), Click (select a box), Delete / Backspace and Esc.
   - The Undo hint becomes "Takes back the last stroke, fill, applied selection or box edit."

**Out of scope:** the boxes list (spec 065), saving (spec 066), Smart boxes (spec 067), export, rotated boxes, multi-select, arrow-key nudges, copy and paste.

## Interfaces
- `ui/kinds.ts`: `KindId = "mask" | "box"`. `BrushMode` gains `"box"`.
- `map/boxLayer.ts`: `boxLayer(map)` returns:
  - `open(grid)`;
  - `show(boxes: Iterable<Box>, colours: string[], selected: number | null, handles: boolean)`;
  - `edit(r: Rect | null, colour)`;
  - `visible(on)`;
  - `handleAt(r: Rect, x: number, y: number): Handle | null`, in screen px.
- `map/boxTool.ts` handles Box mode's pointer events and hands `draw | move | resize | click` gestures to `ui/boxes.ts`. Its exact shape is the implementer's call, but `map/brush.ts` must stay under 200 lines.
- `ui/boxes.ts` holds the store, selection, undo entries, keys and status text. The e2e hook `__geoapp.boxes()` returns the store's boxes.

## Acceptance criteria
1. **Unit (ui/boxes, fake layer and history):**
   - A drawn box is one box with the selected value, and one entry.
   - Escape mid-drag adds nothing, and a move by 0 px adds no entry.
   - Delete and a class change are each one entry. The same class adds none.
   - Locked or peeking, each of these does nothing.
2. **Unit (map/boxTool, fake map and pointer events):**
   - A drag on empty imagery draws, on the selected box moves it, and near a handle resizes it. A corner wins over an edge within 6 px.
   - A move within 4 px is a click.
   - Space held, a middle press or touch draws nothing. An Alt press picks.
   - In Box mode the three handlers are off, and they come back on leaving it.
3. **Unit:** a click cycles through nested boxes, and a click on no box clears the selection.
4. **Unit (boxLayer):**
   - During a drag only the edit source gets `setData`, and the edited box is filtered out.
   - A release sets the boxes source once.
5. **Unit (kinds and labelKeys):**
   - `R` from Masks selects Boxes and Box, and `B` from Boxes selects Masks and Paint.
   - Spec 039 criterion 1 holds with `R` and Delete.
   - Backspace deletes a box only when no polygon corner was removed.
6. **E2E (fixture):** `R` then a drag from pixel (10, 10) to (40, 30):
   - `__geoapp.boxes()` holds `{ x0: 10, y0: 10, x1: 41, y1: 31 }` with the selected value;
   - `queryRenderedFeatures` at its edge finds it;
   - Ctrl+Z removes it, and Ctrl+Y restores it.
7. **E2E:**
   - A move, an `se` resize, a class change with `2`, and Delete each give the expected box.
   - Each is undone by one Ctrl+Z.
8. **E2E:**
   - H hides the boxes, and `R` shows them again.
   - With a box drawn, opening another raster asks spec 032's question, and Cancel keeps the box.
9. **E2E:**
   - Spec 035 criterion 1 holds: the strip is still 56 px wide.
   - At 1280×720, every visible control in `#tools` lies inside the viewport in both kinds.
   - The existing suite passes. The only edits are ones forced by `#kinds` (Tab order, positions), and each is listed.
10. `npm run check` passes.
11. **Docs:**
    - The README describes Boxes and says that, until spec 066, they aren't kept across a reload.
    - The CHANGELOG gets an entry.
