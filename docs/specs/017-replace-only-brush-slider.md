# 017: Imports always replace; the brush size is a slider

**Goal:** Remove the Seed mode select, so every import replaces the labels (after a confirm when any exist), and set the brush size with a 1-127 px slider.

**Status:** Approved (Gage, 2026-10-29: "yes to all"). The request, verbatim: "Remove the seed mode option. Make the brush a slider instead of fixed sizes. Keep the cap though." **ADRs:** none (no new dependency or architecture change). **Build after spec 014 merges.** This spec amends specs 003, 004, 009, 010 and 014 (see Amendments). Amended by spec 047 (2026-11-01): there is no import-time class map, so "Cancel keeps the chosen class map" (scope and criterion 5) lapses.

**Amended by spec 052 (2026-11-02):** `nav-select.tester.spec.ts` (Amendments, spec 009 criterion 6 line) is removed; the class-name cases in `navigation.spec.ts` and `nav-undo.tester.spec.ts` take the same `typing()` path.

**Amended by spec 061 (2026-11-12):** `nav-undo.tester.spec.ts` is deleted, so the class-name case of spec 052's note is covered by `navigation` "W typed in a class name field" alone. The checks that a size change mid-stroke applies to later cells only (`label-view.tester`) and that the brush size is kept on an open (`label-view`) are deleted.

**Decided (Gage, 2026-10-29):**
- Every import replaces, with spec 004's `confirm("Replace labels?")` when any label or mask exists. Always Merge was rejected: spec 014 refuses Merge onto a loaded mask, so a second mask could never load.
- "−" and "+" stay beside the slider, as coarse steps. `[` and `]` halve or double the size (`stepBrush`), which from 7 gives today's sizes exactly.
- Sizes are odd only (step 2), so the square centres on the pointer's pixel.

## Spec 014
Spec 014 is amended in the same change: Merge, its refusal message and its criterion 10 are gone, so it is Replace only, and its cap message drops "with Replace". Its base, copy-on-touch, preview, export and undo are unaffected.

## Interfaces (`core/`)
```ts
const BRUSH_MIN = 1, BRUSH_MAX = 127, BRUSH_STEP = 2; // the cap stays 127
const DEFAULT_BRUSH = 7;
stepBrush(side: number, dir: 1 | -1): number
  // up: min(BRUSH_MAX, 2·side + 1); down: max(BRUSH_MIN, 2·floor((side − 1) / 4) + 1); always odd
```
Removed: `BRUSH_SIZES`, `mergeTile`, and the `SeedMode` type and parameter of `io/seeding` `importLabels`. `mergeClasses` stays, because Replace calls it with `[]`.

**Rules.**
- **Import.** `#seed-mode` and its label are removed.
  - With no labels (`hasLabels` false), an import replaces with no confirm.
  - Otherwise, `confirm("Replace labels?")` comes first. Cancel changes nothing and keeps the chosen class map.
  - The result is spec 004's Replace (spec 014's, once a base exists).

  Everything else in spec 004's import is unchanged: the checks, class table, messages, locks and reads.
- **Slider.** `#brush-size-range` is `type="range"` with min 1, max 127, step 2 and value 7. `#brush-size` reads "Brush: N px". The slider sets the size on `input`, so it updates live while dragging. "−"/"+" and `[`/`]` apply `stepBrush` and move the slider to match. The size is kept when another raster opens.
- **Keys.** A focused slider takes the browser's native arrow and Page keys. It isn't a text field (`inTextField` excludes `range`), so `[`, `]`, `1`-`9` and WASD still work while it has focus. Spec 003's Space rule applies to it as to any input: Space pans when the slider was focused by mouse, and acts natively when it was focused by keyboard.
- **Footprint and cursor.** The footprint is `footprint(…, side)`, a side x side square centred on the pointer's pixel, unchanged.
  - A size change redraws the ring at once when the pointer is on the map. While the slider is dragged, the pointer is over the panel, so no ring shows (spec 003 Hover).
  - A change mid-stroke applies to later cells.
  - Spec 010's 32 px cursor doesn't scale; only the footprint shows the size.

**Amendments.**
- Spec 003 Brush: "step through `BRUSH_SIZES`" becomes "apply `stepBrush`; the slider sets any odd size". Criterion 13 still holds as written.
- Spec 004:
  - Merge lapses, and with it criterion 6's `mergeTile` sentence and criterion 13's last sentence.
  - The Inputs rule "Seed mode resets to Merge" lapses.
  - Criterion 16's Merge and Seed mode clauses are replaced by criterion 5 below. Its 255-class clause becomes "a file with 256 distinct values and no GDAL_NODATA shows the too-many message".
- Spec 010:
  - Undo: `onChange` no longer syncs Seed mode.
  - Criterion 5: "a successful Merge import" becomes "a successful import", and its last bullet lapses. The cancelled Replace clause stays.
- Spec 009 criterion 6 and spec 003's Space rule keep their select clauses, but the app no longer has a select. Tests add a `<select>` to `#panel` from the test itself (`nav-select.tester.spec.ts`).
- The implementer's report lists each test deleted or edited, among them `label-merge.spec.ts`, `seedMerge.test.ts` and `undo-seed*.spec.ts`.

## Acceptance criteria
1. `stepBrush` (unit): up maps 1→3, 3→7, 7→15, 9→19, 63→127, 99→127 and 127→127. Down maps 127→63, 9→5, 7→3, 5→3, 3→1 and 1→1. For every odd s from 1 to 127, both results are odd and lie within 1..127.
2. Slider (e2e, EPSG:4326 fixture): `#brush-size-range` has min 1, max 127, step 2 and value 7. Setting it to 41 shows "Brush: 41 px". A click away from the edges then labels exactly a 41 x 41 square centred on `pixelAt`, and the hover ring equals `footprintRing` of that footprint.
3. Keys (e2e): `]` pressed 4 times from 7 gives slider and text 127, and a fifth press keeps it there. `[` steps down to 1 and stops. With the slider focused, `]` still steps, and ArrowRight gives 9 from 7. Typed in a class name field, `[` and `]` change nothing. Spec 003 criteria 12 and 13 pass unchanged.
4. Space (e2e): after a mouse click on the slider, a left drag with Space held pans and the size is unchanged. After Tab to the slider, Space doesn't pan.
5. Import (e2e): no element `#seed-mode` exists.
   - With no labels, an import shows no confirm.
   - With painted tiles, an import shows "Replace labels?". Cancel keeps the labels, the classes and the class map; OK replaces them.
   - With only a mask loaded (`tiles` empty), the confirm shows, and OK replaces the base.
   - After a successful import, Undo is disabled.
6. WASD and select (e2e): spec 009 criterion 6 passes with a test-added select in `#panel`.
7. Existing: spec 004 criteria 1-4, 7-12, 14, 15 and 19, criterion 16 as amended, and spec 014 criteria 1-9 and 11-14 pass.
