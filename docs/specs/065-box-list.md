# 065: Boxes list in the side panel

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** 0037 (plain DOM, keyed rows). **Builds on specs 035, 036, 062, 063 and 064.** It is part of the series in spec 062.

## Decided (Gage, 2026-11-12: the recommended answers)
1. **Order.** Rows follow box id, which is creation order, newest at the bottom. They are not grouped by class.
2. **Size.** There is no row cap. Updates are keyed (criterion 3), not limited to the newest 500 rows.

**Goal:** In the Boxes kind, the side panel lists every box. A row selects its box and brings it into view.

## Scope
1. **Section.**
   - `<section id="box-section" data-kind="box">` sits in `#panel` between `#class-section` and `#label-section`. It is the `box` kind's section in `KINDS`, so it shows only in Boxes (spec 062 scope 3).
   - Its header `<h2>` reads `Boxes (<n>)`, where n is the number of boxes.
   - In Boxes, `#classes` and `#box-list` share the free height equally, and each scrolls inside itself. In Masks, `#classes` fills it as now (spec 035).
2. **Row.** `<li class="box-row" data-id="<id>">` in `<ul id="box-list">`, in ascending id order. A box restored by undo goes back to its id position. Left to right, it holds:
   - a 12 px swatch of the class colour (a `span`, not an input);
   - a `button.box-pick` holding the class name and `<w>×<h>` (px);
   - a `✕` button with `aria-label="Delete box <id>"`.
3. **Selecting.** A click on, or keyboard activation of, `.box-pick` selects the box (spec 064 scope 3).
   - If the box's ring isn't wholly inside the map's bounds, the map eases to `fitBounds(ring, { padding: 80, maxZoom: <current zoom> })`. So it pans, and it zooms out only if the box doesn't fit.
   - The selected row has `aria-selected="true"` and scrolls into view (`block: "nearest"`). That also happens when the box is selected on the map or by Smart select (spec 067).
4. **Deleting.** `✕` deletes the box exactly as the Delete key does: one undo entry, blocked while locked or peeking. When locked, `✕` is disabled. Selection still works (as spec 036 scope 4).
5. **Updates (keyed).**
   - An add, edit, delete, undo or redo updates only the rows whose ids it names, plus the header count.
   - A recolour or rename of a class updates only that class's rows.
   - An open, an import or a session restore rebuilds the list.
6. **Masks label.** `#mask-view` gains a visible "Masks" label before its slider, so the opacity row says which kind it affects. Show (H) stays one checkbox for every kind (spec 064 decision 4).

**Out of scope:** filtering or sorting, multi-select, renaming or reclassing from a row (selecting the class does that, per spec 064), per-box notes, a list for masks.

## Interfaces
- `ui/boxList.ts`: `initBoxList({ list: HTMLUListElement, head: HTMLElement, select(id): void, remove(id): void, classes(): LabelClass[], locked(): boolean })`. It returns:
  - `reset(boxes: Iterable<Box>)`;
  - `changed(ids: number[])` (it reads each id's current box from a getter, or removes the row when the box is gone);
  - `recoloured(value: number)`;
  - `selected(id: number | null)`;
  - `render()` (applies the lock state).
- `map/boxLayer.ts` (spec 064) gains `reveal(r: Rect)`, which applies scope 3's easing.
- No `core/` change.

## Acceptance criteria
1. **Unit (DOM):**
   - `reset` of 3 boxes gives 3 rows in id order, each with the class colour, the class name and `w×h`.
   - The header reads `Boxes (3)`.
2. **Unit:**
   - A click on `.box-pick` calls `select(id)`.
   - A click on `✕` calls `remove(id)` and not `select`.
   - When locked, `✕` is disabled.
3. **Unit (keyed):**
   - After `changed([id])` for an edit, every other row element is the same object (`===`) as before.
   - After a delete and its undo, the row is back at its id position.
4. **Unit:** `recoloured(v)` changes the swatches of value-v rows only, and `selected(id)` sets `aria-selected` on exactly one row.
5. **E2E (fixture):**
   - Draw 2 boxes, pan until the first is off-screen, then click its row. It is selected, and its ring lies inside the map bounds.
   - `✕` on a row removes the box and its row, and one Ctrl+Z restores both.
6. **E2E:**
   - In Masks, `#box-section` is hidden.
   - With 60 classes and 200 boxes (seeded through the e2e hook) in Boxes, `#classes` and `#box-list` both scroll, and `#label-section` stays visible (spec 035 criterion 5).
7. **Perf (e2e):** with 5,000 boxes seeded, drawing one more box runs no task over 50 ms (PerformanceObserver `longtask`).
8. `npm run check` passes. Specs 035 and 036's e2e criteria pass.
9. **Docs:** the README mentions the boxes list, and the CHANGELOG gets an entry.
