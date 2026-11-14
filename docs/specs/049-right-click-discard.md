# 049: Right click discards a smart selection

**Status:** Approved (Gage waived review, 2026-11-02, as relayed by the orchestrator), with the recommended answers. **ADRs:** none. **Builds on spec 046.** **Amends spec 046:** scope 3 (right click no longer adds an exclude point), scope 8 and criterion 7 (the help entries). Checked against maplibre-gl 6.16.0 (`node_modules/maplibre-gl/src/ui/handler/box_zoom.ts`).

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `right-click-discard.tester`; unit `map/brush.discard.tester` (scope 4). The base `map/brush` tests stay.

**Request** (Gage, 2026-11-02): "Put in the feature to forgo the smart select that was made by doing a right click. This way you can reset quickly."

## Decided (2026-11-02, recommended options)
1. **Exclude points.** Today a right click in Smart mode adds an exclude point (spec 046 scope 3), so making it discard takes that away. Exclude points move to Shift+click.
2. **After Enter.** Once a fill is applied, its prompt is gone, so nothing is pending. A right click with no prompt does nothing, and Ctrl+Z undoes a fill as now.

## What happens today (from the code)
- A pending selection is `initSmart`'s `prompt` (window, include and exclude points, an encode in flight) plus the shown `mask` and the enabled `#smart-apply` (`ui/smart.ts`). Nothing reaches the labels or undo until Enter.
- In Smart mode, `map/brush.ts` records a left or right press (no Alt, no Space, imagery open). A release of the same button within 4 px on a raster cell calls `click(cell, include)`. A larger drag goes to MapLibre: left pans, and right rotates (`dragRotate` is on outside Paint and Erase).
- `contextmenu` is already prevented on `#map` whenever imagery is open (spec 003), on press or late release.
- Escape calls `discard()`. It aborts the encode's read, clears the points and mask, and disables `#smart-apply`. It keeps the worker's embedding, the labels, undo and the mode. With no prompt, Escape selects Pan.

## Scope
1. **Right click discards.** In Smart mode, a right press and release within 4 px anywhere on the map canvas (on or off the raster) does what Escape does with a prompt: `discard()`. It doesn't touch labels or undo. It keeps the embedding, so the next click in the same window decodes without encoding. It keeps Smart mode. With no prompt, it does nothing; unlike Escape, it never selects Pan (Decided 2).
2. **A fill being applied.** A right click after Enter but before the fill lands still clears the preview. The fill lands, and one Ctrl+Z undoes it.
3. **Exclude point (Decided 1).** Shift + a left click within 4 px on a raster cell adds an exclude point. In Smart mode, a Shift+left mousedown on the canvas is stopped before MapLibre, as Paint's presses are. Otherwise MapLibre's box zoom starts, and a release 1–4 px away calls `fitScreenCoordinates` on that tiny box (`box_zoom.ts` 141–163).
4. **Unchanged.** A right drag over 4 px rotates as before and discards nothing. Alt or Space held: a right click does nothing. Paint, Erase and Pan modes handle right clicks as before. No context menu shows on the map while imagery is open. Pen barrel-button presses (button 2) count as right clicks; touch never does.
5. **Help.** `SHORTCUTS`: `smart-point` becomes keys `["Click", "Shift+click"]`, "Include / exclude a point", and `smart-discard` becomes keys `["Escape", "Right click"]`, "Discard the selection".

**Out of scope:** undoing an applied fill by right click (Decided 2); removing single points; a confirm before discarding.

## Interfaces
- `map/brush.ts` `Deps`: `click?: (cell: [number, number], include: boolean) => void`, where `include` is now false for Shift+left. A new `discard?: () => void` is called on a Smart-mode right click.
- `ui/labels.ts` wires `discard` to `smart?.discard()`. `ui/smart.ts` and `core/` are unchanged.

## Acceptance criteria
1. **Unit (map/brush, Smart mode, imagery open):**
   - A right press and release 3 px apart, on the raster or off it, calls `discard` once and `click` never.
   - A right drag of 10 px calls neither.
   - A left click calls `click(cell, true)`, and a Shift+left click calls `click(cell, false)`.
   - Alt+right, and a right click with Space held, call neither.
   - In Paint mode a right press still erases, and `discard` isn't called.
2. **Unit (map/brush):** in Smart mode, a Shift+left `mousedown` on the canvas has `stopPropagation` called; a plain left one doesn't.
3. **Unit (ui/smart, fake Segmenter):** after a click and a shown mask, `discard()` hides the mask, and a decode resolving afterwards changes nothing. A next click in the same window decodes without a second `encode`. With no prompt, `discard()` returns false and calls nothing.
4. **E2E (fake Segmenter, Smart mode):**
   - A click shows the preview, and a right click hides it and disables `#smart-apply`. Enter then labels nothing, the mode is still Smart, and Undo stays disabled.
   - After a click and Enter, a right click leaves the fill, and one Ctrl+Z removes it.
   - A right click with no prompt leaves `#mode-smart` pressed.
   - Every right click above leaves `contextmenu` `defaultPrevented`.
5. **E2E:** a Shift+left release 3 px from its press leaves the map's zoom unchanged and adds an exclude point: the fake Segmenter receives label 0.
6. **E2E:** `#help` lists "Click / Shift+click" for Include / exclude a point and "Esc / Right click" for Discard the selection. Spec 039 criterion 1 passes.
7. `npm run check` passes. Spec 046's criteria pass, with criterion 7's help text as in criterion 6 here, and specs 003 and 038's e2e criteria pass.
