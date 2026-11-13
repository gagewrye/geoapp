# 056: Brush + above −, Apply only in Smart select, file buttons without "No file chosen"

**Status:** Accepted (2026-11-11). **ADRs:** none (no dependency or architecture change). **Amends spec 035** scope 3 (brush order) and **spec 046** (the Apply button's visibility). **Depends on spec 055:** both touch the Smart select UI. Build this on a branch from `main` after 055 merges. 055's failure paths leave the mode unchanged, so criterion 4 applies to them.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `tool-strip-tidy` (criteria 1, 2 and 7) and `tool-strip-tidy.tester` (3 and 8). No test of this spec is left.

**Request** (Gage, verbatim): "Also, on the paintbrush size, the plus and minus buttons are backwards and unintuitive. swap them. The apply smart select button should only be visible when smart select is active. The choose file buttons should not have n. when nothing is selected. Just leave it blank."

## Open questions (the spec does the recommended answer)
1. **After a file is chosen.** The fix hides the input's own text all the time, so a chosen file's name doesn't show beside the button either. `#raster-info` already shows the raster's name, and Import labels and Class map reset their value after use. Recommended: blank always. The alternative is blank only when empty, which needs JS on `change`.
2. **Which swap.** Recommended: swap the two buttons, so the strip reads + / number / − / slider. The alternative is + above the slider and − below it.
3. **Layout shift.** When Apply shows, the controls below it move down one button (about 36 px). The alternative is `visibility: hidden`, which keeps the gap. Recommended: let them move.

## Findings
- **Brush.** In `index.html`, the strip runs top to bottom: `#brush-smaller` (−), `#brush-size`, `#brush-larger` (+), then the vertical slider. The slider puts larger sizes at the top (`style.css`: `direction: rtl`). So − sits above the end of the slider that means "larger". The buttons work correctly (`ui/brushSize.ts`). Only their position is backwards.
- **Apply.** `#smart-apply` (✓) is always in the strip. `ui/smartTool.ts` only toggles `disabled`, which is true until a mask shows.
- **"n."** No code puts this text there (grep of `src/`). It comes from the browser's native `<input type="file">` text, "No file chosen" in Chrome or "no file selected" in Safari. `style.css:10` sets `#topbar input[type=file] { width: 96px }`, and the "Choose File" button takes most of that width. The rest of the text is cut to "n…", which reads as "n.". The lowercase n points to Safari. This affects `#open-raster`, `#import-labels` and `#class-map`.

## Scope
1. **Brush order.** In `#brush-panel`, `#brush-larger` (+) comes first, then `#brush-size`, then `#brush-smaller` (−), then `#brush-size-range`. Only the DOM order changes. The ids, labels, titles, `[`/`]` and `stepBrush` stay the same.
2. **Apply visibility.** `#smart-apply` has `hidden` exactly when the mode isn't `"smart"`. The mode change sets it (`ui/modes.ts` `setMode`, the one place every mode change goes through). Its `disabled` rule and Enter are unchanged.
3. **File inputs.** The three file inputs in `#topbar` show their native button and no text beside it. This is CSS only. Make the input's own text transparent, and give `::file-selector-button` an explicit colour. MDN says the pseudo-element's colours "won't necessarily inherit" from the input, so this colour must be set, not inherited. The inputs stay real, focusable and clickable, which spec 050's click handler and `setInputFiles` need.

**Out of scope:** custom file buttons or labels, an Apply button for Polygon, restyling the strip.

## Interfaces
No `core/` change. Files touched: `index.html`, `src/ui/style.css`, `src/ui/modes.ts`. No new exports.

## Acceptance criteria
1. **E2E (after open):** in `#brush-panel`, the order is `#brush-larger`, `#brush-size`, `#brush-smaller`, `#brush-size-range`. That holds for both DOM order and bounding-box top values, top to bottom.
2. **E2E:** from 7, clicking `#brush-larger` gives 15 and clicking `#brush-smaller` then gives 7. `[` and `]` behave as in spec 017 criterion 3.
3. **E2E:** with `#brush-smaller` focused, Shift+Tab focuses `#brush-larger`. Two tests Tab from − to + and are edited to use Shift+Tab: `brush-pan.spec.ts`, around line 135, and `brush-space-focus.tester.spec.ts`, around line 108. Their assertions are otherwise unchanged.
4. **E2E (Smart stubbed as in `smart-select.spec.ts`):**
   - After open, in Pan, `#smart-apply` is hidden.
   - After `M`, it is visible and disabled. After a click shows a mask, it is enabled.
   - Choosing each of Pan, Paint, Erase, Fill and Polygon, by button or key, hides it. Escape with no prompt (Pan) also hides it.
   - Choosing Smart again shows it.
5. **E2E:** after a load failure (spec 055 criterion 7's route), the mode is unchanged and `#smart-apply` stays hidden.
6. **E2E:** spec 046's commit criterion still passes. In Smart, a click on the visible `#smart-apply` labels the mask, and so does Enter.
7. **E2E:** for each of `#open-raster`, `#import-labels` and `#class-map`, before any choice and after a `setInputFiles`, the input's computed `color` has alpha 0. The computed `color` of its `::file-selector-button` has alpha 1.
8. **Manual (tester, Chrome and Safari):** before and after opening a raster, no text shows beside any of the three "Choose File" buttons, and each opens its chooser.
9. **Docs:** spec 035 scope 3 reads "brush +, `#brush-size` showing only the number, then −". Spec 046's header names this spec for Apply's visibility.
10. `npm run check` passes, and the existing e2e suite passes with only criterion 3's edits.
