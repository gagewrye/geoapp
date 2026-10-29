# 016: Label opacity, a Show labels toggle, and Pan on load

**Goal:** Let the user dim or hide the labels to see the imagery under them, and start each newly loaded label set in Pan mode.

**Status:** Approved (Gage, 2026-10-29: "yes to all"). The request, verbatim: "We need to implement transparancy and the ability to toggle off view of the labels. In addition, when labels load it should start off in pan mode instead of paint mode." The rest of that request is spec 017, and the outline defect is spec 018. **ADRs:** none. There is no new dependency, and opacity and visibility are ordinary maplibre-gl 6.16.0 paint and layout properties (`raster-opacity`, `visibility`). **Build after spec 014 merges**, because this spec drives spec 014's `mask` layer. Amends specs 003, 010 and 014 as listed under Amendments.

**Decided (Gage, 2026-10-29):**
- Opacity isn't saved across reloads. It is kept for the page session, including when another raster opens.
- Painting is blocked while labels are hidden, because an edit you can't see is easy to make by mistake.
- "When labels load" means both opening a raster and a successful import. Before this, `ui/labels.ts` `open()` set Paint, and an import kept the current mode.
- Show labels has no keyboard shortcut.

## Scope
**In:** an Opacity slider and a Show labels checkbox that act on the label overlays and the mask; blocking the brush while labels are hidden; Pan as the mode after an open or an import.
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
- **Painting while hidden.** While Paint applies (spec 010 Cursor) and labels are hidden:
  - strokes don't start, and a stroke in progress ends when labels are hidden;
  - the footprint isn't shown, and the map canvas shows `cursor: not-allowed` (spec 010's locked cursor);
  - a left or right press on the map shows "Labels are hidden. Turn on Show labels to paint."

  Pan mode, Space, middle pan, the wheel and WASD are unchanged. Undo, Import labels, Export labels and class edits still work. When labels are shown again, the brush cursor and footprint return without the pointer having to move.
- **Pan on load.** Opening a raster sets Pan, and so does a successful import (one that calls `replace()`). A cancelled confirm, a refused or failed import, "No labels to seed here." and a stale import all keep the current mode. In `index.html`, `#mode-pan` starts with `aria-pressed="true"`.

**Amendments.**
- Spec 003 Modes: "Paint (the default on open)" becomes "Pan is the default on open and after an import".
- Spec 003 Display and spec 014 Display: "`raster-opacity` 0.6" becomes "the Opacity value (default 0.6), shown only while Show labels is on".
- Spec 010 Locked cursor: it also applies while labels are hidden.
- Spec 010 criterion 8, third bullet: after the import finishes, the mode is Pan, so the cursor is MapLibre's. The Export bullet is unchanged.
- **Tests.** E2e tests that paint after an open or an import click `#mode-paint` first, through one helper. Because the default opacity stays 0.6, spec 011 criterion 6 and spec 014 criterion 11 are unchanged.

## Acceptance criteria
1. Controls (e2e): with imagery open, `#label-opacity` is a range from 0 to 100, step 5, at 60, and its text reads "Opacity: 60%". `#show-labels` is checked. Both are enabled while an import with a paused file source runs.
2. Opacity (e2e, mask imported plus one painted tile, basemap hidden): setting 30 makes `raster-opacity` 0.3 on every `label-` layer and on `mask`, and on a tile painted afterwards. A labelled pixel then renders as 0.7 x the imagery plus 0.3 x the class colour, within 3 per channel.
3. Kept (e2e): after opening another raster (OK on the confirm), the slider still reads 30 and a new overlay gets 0.3. After a reload it reads 60.
4. Hide (e2e): unchecking sets `visibility` to `none` on every `label-` layer and on `mask`. At a labelled point the rendered pixel matches the imagery alone, within 2 per channel. Every stored tile is byte-equal to before, and the class list and Undo's enabled state are unchanged. An Undo while hidden restores the store, and the overlay it recreates has `visibility` `none`. Checking the box again brings the class colour back.
5. Blocked (e2e, Paint mode, labels hidden): a left drag and a right drag change no tile and show the message. No hover feature exists, and the canvas cursor is `not-allowed`. A drag with Space held pans. After the box is checked, with no pointer move, the cursor starts with `url("data:image/svg+xml` and the footprint shows.
6. Reset (e2e): with labels hidden, opening another raster leaves `#show-labels` checked and Pan selected.
7. Pan on load (e2e): after an open, `#mode-pan` is pressed, a left drag pans and paints nothing, and no footprint shows. After clicking Paint, a successful import selects Pan. A cancelled Replace confirm, a refused 3-band file and a "No labels to seed here." import all leave Paint selected.
8. Existing (e2e): spec 003 criteria 9-14, 16, 18 and 19, spec 010 criteria 3-8 (as amended) and spec 014 criterion 11 pass, with tests selecting Paint first.
