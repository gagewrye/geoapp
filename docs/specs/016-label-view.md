# 016: Label opacity, a Show labels toggle, and Pan on load

**Goal:** Let the user dim or hide the labels to see the imagery under them, and start each newly loaded label set in Pan mode.

**Status:** Approved (Gage, 2026-10-29: "yes to all"). The request, verbatim: "We need to implement transparancy and the ability to toggle off view of the labels. In addition, when labels load it should start off in pan mode instead of paint mode." The rest of that request is spec 017, and the outline defect is spec 018. **ADRs:** none. There is no new dependency, and opacity and visibility are ordinary maplibre-gl 6.16.0 paint and layout properties (`raster-opacity`, `visibility`). **Build after spec 014 merges**, because this spec drives spec 014's `mask` layer. Amends specs 003, 010 and 014 as listed under Amendments.

**Amended** (Gage, 2026-10-29): "instead of making the pointer show as blocked when hiding labels, just make it go to pan mode instead. That way there is no blocked state or message to worry about and the user can pan easily." This removes the blocked state. Gage approved the amendment, including the edge cases under "Hiding selects Pan" (Gage, 2026-10-29: "approve").

**Amended by spec 061 (2026-11-12):** the tester files `label-view.tester.spec.ts`, `label-view-pan.tester.spec.ts` and `cursor-lock.tester.spec.ts` are deleted. Criteria 4-6 stay covered by `label-view` 122, 145, 163, 188, 217 and 245, and the lock cursor by `cursor-lock` 64. Lost: hidden labels combined with import and export locks, Space and class edits while hidden, and an import while hidden.

**Decided (Gage, 2026-10-29):**
- Opacity isn't saved across reloads. It is kept for the page session, including when another raster opens.
- Labels are never painted while hidden: hiding them selects Pan.
- "When labels load" means both opening a raster and a successful import. Before this, `ui/labels.ts` `open()` set Paint, and an import kept the current mode.
- Show labels has no keyboard shortcut.

## Scope
**In:** an Opacity slider and a Show labels checkbox that act on the label overlays and the mask; selecting Pan when labels are hidden; Pan as the mode after an open or an import.
**Out:** saving view settings; a shortcut key; per-class visibility or opacity; changing the hover footprint's look; changing the imagery or basemap opacity.

## Interfaces
No `core/` change. In `map/`:
```ts
type LabelView = { opacity: number; visible: boolean }; // opacity 0..1
applyLabelView(map: MapLibreMap, view: LabelView): void
  // raster-opacity and visibility on every layer whose id starts with "label-", and on "mask"
```
`LabelOverlays` and spec 014's mask layer create their layers with the current view. The default opacity, 0.6, moves out of `labelOverlay.ts` into one constant.

**Rules.**
- **Controls.** These go in the Labels panel, under Paint/Pan:
  - `#label-opacity`, labelled "Opacity": `type="range"` with min 0, max 100, step 5 and value 60, plus the text `#label-opacity-text`, which reads "Opacity: 60%".
  - `#show-labels`, labelled "Show labels": a checkbox, checked by default.

  Both stay enabled while the panel shows, including during spec 004's locks, because they change no labels.
- **Opacity.** On each `input` event, so it updates live while dragging, `raster-opacity` becomes value / 100 on every overlay and on the mask. The hover footprint keeps `fill-opacity` 0.4. The value is kept when another raster opens.
- **Show labels.** Unchecking it sets `visibility: none` on every overlay and on the mask, including any created while labels are hidden (by Undo, an import or an applied queued cell). Checking it shows them again. The store, class list, undo history and exports are unchanged. It resets to checked when a raster opens.
- **Hiding selects Pan.** Paint never applies while labels are hidden.
  - Unchecking Show labels selects Pan, with the same effect as clicking `#mode-pan`. There is no blocked state, message or `not-allowed` cursor.
  - A stroke in progress ends at once. Cells it already queued still apply, and the stroke stays one undo step (spec 010).
  - Clicking `#mode-paint` while labels are hidden checks Show labels first, which shows the labels, so Paint always draws onto visible labels.
  - Checking Show labels keeps the current mode; it doesn't restore Paint.
  - Holding Space already acts as Pan, so it changes nothing here.
  - During spec 004's locks, Show labels and the mode buttons work as above. An import that finishes selects Pan anyway and leaves Show labels as it is.
  - Undo, Import labels, Export labels and class edits still work while labels are hidden.
- **Pan on load.** Opening a raster sets Pan, and so does a successful import (one that calls `replace()`). A cancelled confirm, a refused or failed import, "No labels to seed here." and a stale import all keep the current mode. In `index.html`, `#mode-pan` starts with `aria-pressed="true"`.

**Amendments.**
- Spec 003 Modes: "Paint (the default on open)" becomes "Pan is the default on open and after an import".
- Spec 003 Display and spec 014 Display: "`raster-opacity` 0.6" becomes "the Opacity value (default 0.6), shown only while Show labels is on".
- **Removed with the blocked state:**
  - in `map/brush.ts`: the `hidden` flag, `setHidden`, the `refused` dependency, and `blocked()`'s hidden term;
  - `MESSAGES.labelsHidden`, and its wiring in `ui/labels.ts`. The `initLabelView` callback now selects Pan when labels are hidden.
  - the criterion 5 tests in `tests/e2e/label-view.spec.ts` and `label-view.tester.spec.ts`, which are replaced by the new criteria 5 and 6.

  Spec 010's Locked cursor no longer mentions hidden labels; it covers locks only.
- Spec 010 criterion 8, third bullet: after the import finishes, the mode is Pan, so the cursor is MapLibre's. The Export bullet is unchanged.
- **Tests.** E2e tests that paint after an open or an import click `#mode-paint` first, through one helper. Because the default opacity stays 0.6, spec 011 criterion 6 and spec 014 criterion 11 are unchanged.

## Acceptance criteria
1. Controls (e2e): with imagery open, `#label-opacity` is a range from 0 to 100, step 5, at 60, and its text reads "Opacity: 60%". `#show-labels` is checked. Both are enabled while an import with a paused file source runs.
2. Opacity (e2e, mask imported plus one painted tile, basemap hidden): setting 30 makes `raster-opacity` 0.3 on every `label-` layer and on `mask`, and on a tile painted afterwards. A labelled pixel then renders as 0.7 x the imagery plus 0.3 x the class colour, within 3 per channel.
3. Kept (e2e): after opening another raster (OK on the confirm), the slider still reads 30 and a new overlay gets 0.3. After a reload it reads 60.
4. Hide (e2e): unchecking sets `visibility` to `none` on every `label-` layer and on `mask`. At a labelled point the rendered pixel matches the imagery alone, within 2 per channel. Every stored tile is byte-equal to before, and the class list and Undo's enabled state are unchanged. An Undo while hidden restores the store, and the overlay it recreates has `visibility` `none`. Checking the box again brings the class colour back.
5. Hiding selects Pan (e2e, Paint mode):
   - Unchecking `#show-labels` presses `#mode-pan`.
   - A left drag then moves the map centre and changes no tile. No hover feature exists. The canvas cursor neither starts with `url(` nor is `not-allowed`. `#message` is unchanged.
   - Mid-stroke: hold the left button, move, Tab to `#show-labels` and press Space. The stroke ends, later moves label nothing, and one Undo removes everything the stroke painted.
6. Paint shows labels (e2e):
   - With labels hidden, clicking `#mode-paint` checks `#show-labels` and sets every `label-` layer and `mask` to visible. With no pointer move, the cursor starts with `url("data:image/svg+xml` and the footprint shows.
   - In Pan mode, checking `#show-labels` leaves `#mode-pan` pressed.
   - While an import with a paused file source runs, unchecking selects Pan. After it finishes, Pan is pressed and `#show-labels` is still unchecked.
7. Reset (e2e): with labels hidden, opening another raster leaves `#show-labels` checked and Pan selected.
8. Pan on load (e2e): after an open, `#mode-pan` is pressed, a left drag pans and paints nothing, and no footprint shows. After clicking Paint, a successful import selects Pan. A cancelled Replace confirm, a refused 3-band file and a "No labels to seed here." import all leave Paint selected.
9. Existing (e2e): spec 003 criteria 9-14, 16, 18 and 19, spec 010 criteria 3-8 (as amended) and spec 014 criterion 11 pass, with tests selecting Paint first.
