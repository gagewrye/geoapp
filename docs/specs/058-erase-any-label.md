# 058: Erase removes any label, with an eraser cursor

**Status:** Accepted (2026-11-11). **ADRs:** none (no dependency or architecture change). **Amends spec 033** (scope 1 and 6, criteria 1 and 4, and its out-of-scope line "an eraser that clears every class"), **spec 010** (the cursor in Erase mode) and **spec 057** scope 3 (the `erase` hint is superseded here). **Build after spec 057 merges.** Spec 056 shares no files with this spec: it changes `index.html`, `style.css` and `modes.ts`. Both edit the tool strip's tests, so rebase whichever merges second.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `erase-any` (criteria 5, 7 and 8), `tool-keys` (4) and `label-mask` (6); unit `core/labelStore.eraseAny.tester` (1), `map/brush.eraseKinds.tester` (scope 2), `map/cursor.eraser.tester` (3) and `ui/readme.test` (9). The base `core/labelStore.eraseAny`, `map/brush` and `map/cursor` tests stay; no e2e test of Erase is left.

**Request** (Gage, verbatim): "Change the erase tool to be class agnostic and erase any label. The paint right drag already covers the selected class removal feature." Then: "Also, change the pointer to an eraser".

## Open questions (the spec does the recommended answer)
1. **Right drag in Erase mode** (today it erases the selected class, the same as a left drag). Recommended: it removes any label too, so the whole mode is class-agnostic. The alternative keeps it as the selected class only.
2. **Pen barrel button** (button 2, which the code treats as a right drag). Recommended: it follows the right drag. In Paint it removes the selected class; in Erase, see question 1. A pen's eraser end (button 5) does nothing today and stays out of scope.
3. **Footprint.** Recommended: keep the dashed square, because it is the only thing that shows the brush size (spec 017). Draw it in neutral white instead of the class colour, since Erase no longer depends on the class.
4. **Status bar.** Recommended: `Erase · 7 px`, with no class name. Today it reads `Erase · Water · 7 px`.
5. **Hint wording** (supersedes spec 057's `"Removes the selected class"`). Proposed: `"Removes any label under the brush"`.
6. **Eraser look.** Proposed: a classic block eraser tilted 45°, with a pink tip (`#f28fa5`) toward the lower left and a white sleeve. It has a black 1.2 px outline over a white 3 px halo, the same as the brush cursor.

## Where the selected-class rule lives today
- `core/labelStore.ts`: `brush` and `brushSpans` with `erase: true` zero only pixels where `tile[i] === value`. **Changes.**
- `map/brush.ts:124`: a stroke's `erase` is `mode === "erase" || e.button === 2`, so Erase mode and the right or barrel drag all get the same class-only erase. **Changes.**
- `ui/paint.ts` and `io/paintQueue.ts` pass `erase` through as it comes. Spec 014's base copy runs for erase ops too, so an any-label erase over an imported mask works with no change. Their types widen, and nothing else changes.
- **Undo and redo** (`io/undoHistory`) record tiles before each op, whatever the op does. **Unchanged.**
- `map/hover.ts`: the dashed ring in the class colour. Only its colour changes. `map/cursor.ts`: the brush cursor. An eraser cursor is added.
- `core/status.ts` `formatTool`; `ui/shortcuts.ts` `erase` hint; the README's Label step, which doesn't mention Erase.
- **Specs:** 033 (scope 1 says "the selected class only", criterion 4 says "other classes' pixels are untouched"). Spec 003's right drag and criterion 11's barrel drag are **unchanged**.

## Scope
1. **Erase kinds.** `erase` becomes `false | true | "any"`. `true` keeps today's meaning, the selected class only, so existing callers and tests keep compiling. `"any"` zeroes every pixel the footprint covers. An emptied tile is deleted unless `store.base`, as now.
2. **Strokes.** Erase mode gives `"any"` for left, right and barrel drags (question 1). Paint mode gives `true` for a right or barrel drag and `false` for a left drag. Fill, Polygon and Smart still pass `false`.
3. **Cursor.** In Erase mode, the canvas cursor is `eraserCursor()`. The locked cursor, Space held, Pan and the other modes are unchanged (spec 010). The footprint follows question 3.
4. **Text.** The `erase` hint is question 5's text. `right-erase` ("Erase the selected class (Paint mode)") and the `paint` hint stay. The status bar follows question 4. The README's step 2 gains: "**Erase** (`E`) removes any label under the brush."

**Out of scope:** the pen's eraser end, a size-scaled cursor, and changes to Paint's right drag.

## Interfaces
- `core/labelStore.ts`: `type Erase = boolean | "any"`; `brush(store, masks, w, value, erase: Erase)` and `brushSpans(store, masks, spans, value, erase: Erase)`. `value` is still checked as 1..255 and is ignored under `"any"`.
- `io/paintQueue.ts`: `PaintOp.erase: Erase`. `map/brush.ts` `Deps.cells(cells, side, erase: Erase)`.
- `map/cursor.ts`: `eraserCursor(): string` gives `url("data:image/svg+xml,…") X Y, crosshair`. The SVG is inline, 32×32, with no external asset. The hotspot (X Y) is the middle of the tip's bottom edge, about `6 26`.
- `map/hover.ts`: `ERASE_COLOUR = "#ffffff"`, which the brush passes in Erase mode.
- `core/status.ts`: `formatTool("erase", …)` returns `Erase · <side> px`.

## Acceptance criteria
1. **Unit (core):** in a tile holding 1s, 2s and 0s, `brushSpans(…, "any")` zeroes every pixel in the spans and nothing outside them. `true` with value 1 zeroes only the 1s. With `base` false, an all-zero result deletes the tile; with `base` true, it is kept. `brush` gives the same results.
2. **Unit (brush, synthetic pointer events):** in Erase mode, left and right presses call `cells(…, "any")`. In Paint mode, a left press calls it with `false` and a right press with `true`. In Pan mode, no press calls it.
3. **Unit:** `eraserCursor()` starts with `url("data:image/svg+xml,`, ends with ` crosshair`, and has two integer hotspot numbers in 0..31. Its decoded SVG has `width="32"` and contains no `href` or `url(`. `formatTool("erase", "Water", 7)` is `Erase · 7 px`, and Paint's text is unchanged.
4. **E2E (replaces spec 033 criterion 4):** class 1 and class 2 strokes are painted, then `E` and a left drag over both make every pixel under the drag 0. `ControlOrMeta+z` restores both classes. A right drag in Erase mode does the same.
5. **E2E:** in Paint mode, a right drag over class 1 and class 2 with class 1 selected zeroes only the 1s. Spec 003 criterion 11's pen barrel drag still erases.
6. **E2E (mask base):** after an import, an Erase drag zeroes imported pixels of two classes. Undo shows the mask again.
7. **E2E cursor:** in Erase mode, the computed `cursor` at a map point equals `eraserCursor()`, and is the same after selecting another class. In Paint mode, it is still spec 010's brush cursor. With Space held, in Pan, or while locked, spec 010 criteria 7-8 hold.
8. **E2E footprint:** in Erase mode, the `brush-hover-line` layer has `line-color` `#ffffff` and a `line-dasharray`. In Paint mode, it has the class colour and no dash.
9. **Unit:** the `erase` hint is question 5's text, and every other hint equals its value after spec 057. The README contains the scope 4 sentence.
10. **Docs:** spec 033 and spec 057 each get an "Amended by spec 058" line, and spec 010 a cursor note. `tool-keys.spec.ts`' status texts for Erase change to `Erase · 7 px`. `npm run check` and `npm run e2e` pass.
