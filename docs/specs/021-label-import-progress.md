# 021: Progress while labels import, with the old labels cleared first

**Status:** Approved (Gage, 2026-10-30: "approve all"). **ADRs:** none (no dependency, no new architecture). Amended by spec 047 (2026-11-01): there is no class map; "too many" comes before the pass only when the file's table alone has over 255 entries, else after it.

**Amended by spec 061 (2026-11-12):** the tester file `label-import-progress.tester.spec.ts` is deleted. Criteria 2, 3, 5 and 8 stay covered by `label-import-progress` 79, 121 and 198 and `label-stale` 23. Lost: the import after a Cancel is not pre-cancelled, and restored labels taking Opacity and Show labels set mid-run.

**Request** (Gage, 2026-10-30): "Loading labels in the web app needs a loading bar", and "remove the current label mask when loading new labels as well". Gage's label files are uint8 GeoTIFFs of 6,500² to 11,000² px at 0.1 m, with `GEOAPP_CLASSES`.

Amends specs 004 (the run message) and 014/017 (when the old labels leave the map).

## Decided (Gage, 2026-10-30)
1. There is a Cancel button. Nothing is committed until the import ends, so Cancel restores the old labels exactly.
2. When an import fails, is cancelled or finds no labels, the cleared labels come back. Restoring costs nothing, since the old state is only held, not copied.
3. The imagery read is skipped when the imagery has no nodata value and integer samples.
   - geoapp ignores alpha today, so in that case masking can't change a label, and the skip changes no result.
   - It applies to 80 of the 86 chunks: RGBA uint8, nodata None, 1-row strips. On these the imagery read is likely most of the import time.
   - The 6 uint16 chunks with nodata 256 still read.
   - It also speeds up the mask's base tiles: export, and copy-on-touch for erase cells. A Paint cell still reads imagery for its nodata mask (spec 003); that is spec 023's subject.
4. Fact, from rasterio (2026-10-30): Gage's `labels.tif` files are uint8 with nodata 255 in 1-row strips, and the pseudo-label files are tiled 256. So the striped label files also re-decode strips on each window (out of scope here).

**Known gap, not in this spec: alpha is ignored.**
- `warpPreview` and `toRgba` draw bands 1–3 only, so transparent areas draw as their RGB values, usually black.
- `maskNodata` treats a pixel as nodata only when it equals `nodata` or is NaN, and alpha 0 doesn't count.
- So about 24% of each RGBA chunk (outside the image) shows as imagery and can take labels.
- Honouring alpha (TIFF ExtraSamples = 2, unassociated alpha) would change Decided 3's condition to "no nodata, integer samples and no alpha band". That needs its own spec.

## Where the time goes (`io/seeding.ts` `importLabels`, main 99d363a)
- **Picking the file and the confirm "Replace labels?":** the user's time; nothing is read.
- **Header and class table** (`openLabelFile`, `importTable`): a few small reads.
- **Pass 1, classes from values:** reads every file window once. It runs only when there is no class map and no `GEOAPP_CLASSES`, so Gage's files skip it. (Spec 024 removed this pass: an import is now always one pass.)
- **Pass 2, labelling:** for each `seedWindows` window (256², on the imagery grid; 1,849 for 11,000² on an equal grid):
  - gather the file windows it touches;
  - map them through the LUT;
  - if any label is non-zero, read the whole imagery window (every band, as Float32) and mask nodata;
  - fill the preview.
  - On striped imagery each 256-wide read decodes 256 full-width strips. For Gage's 6,572² RGBA imagery that is about 6.7 MB per window, about 4.4 GB over a full import.
- **Finish** (`labels.replace`, the mask's 1024 px repaint): short, not counted.

## Scope
**Progress.** `<progress id="import-progress" hidden>` and `<button id="import-cancel" hidden>Cancel</button>` sit after `#import-labels`.
- `ui/openProgress.ts` becomes `ui/progress.ts` `initProgress(bar)`, with the same `busy`, `step` and `hide`. Spec 019's bar uses it unchanged. A separate bar keeps an open and an import from hiding each other's.
- **While the header is read:** no bar and no Cancel. The bar starts at the Clear (step 4, after the header checks pass), indeterminate until the first window.
- **During the passes:** value = windows whose file values have been read, out of the seed windows (one pass, spec 024). "Too many" classes is reported after the pass when classes come from values, and before it with a class map or table. `#message` reads "Importing labels…" (was "Seeding labels...").
- **Hidden** when the run ends in any way.

**Old labels cleared at the start.** Order of an import:
1. Pick the file.
2. "Replace labels?" (only if `hasLabels`). Cancel changes nothing.
3. Header and class-table checks. A refusal shows its message, and the old labels stay.
4. Clear, which starts the bar:
   - every `label-` layer and the `mask` layer are removed from the map;
   - the store, classes, base and undo history are held, untouched, while the run's locks stop any edit.
   - Show labels and Opacity still apply to layers made later, so the old labels can't reappear.
5. The passes.
6. **Success:** spec 014's replace; history cleared (spec 010); Pan selected (spec 016).
   - **Failure, Cancel, "empty" or "too many":** the held labels are restored and drawn again, with their history.
     - The messages are as today, plus "Import cancelled." for Cancel.
   - **Replaced by a newer raster:** the open drops everything, as today.

This fits spec 017: the import still replaces and still can't be undone. Only when the old labels leave the map changes, from the end of the run to its start.

**During an import** (spec 004's locks, unchanged):
- **Disabled:** painting, class edits, Undo, Import labels, Class map and Export labels.
- **Allowed:** Pan, Space, WASD, keys 1–9, `[ ]`, Opacity, Show labels and opening a raster.
  - Opening a raster asks the discard confirm, because the held labels still count for `hasLabels`.
  - OK ends the import, with no message from it. Cancel lets the import continue.

**Imagery read skipped (Decided 3).** `windowLabels` reads the imagery window only when `nodata !== null` or the samples are floating point. This matches today's masking, which ignores alpha. If a later spec honours alpha, it must add "or an alpha band" here.

**Out of scope:** faster file reads for striped label files; worker decoding.

## Interfaces
- `io/seeding.ts`: `importLabels(imagery, file, table, stale, onProgress?: (done: number, total: number) => void)`. `stale` also turns true on Cancel.
- `io/source.ts`: `RasterMeta` gains `float: boolean` (SampleFormat 3).
- `core/seed.ts`: `nodataPossible(nodata: number | null, float: boolean): boolean`.
- `ui/labels.ts`: `hold()` removes the layers and returns a token; `restore(token)` redraws the labels and keeps their history.
- `MESSAGES.importing`, `MESSAGES.importCancelled`.

## Acceptance criteria
1. **Unit, fake sources:** `onProgress` is called once per window as its file values are read, with `done` 1..total in order. `total` is `seedWindows(...).length` (one pass, as amended by spec 024).
2. **E2E:** during an import slowed by a test hook, `#import-progress` shows a numeric value, `#import-cancel` is visible, and the message reads "Importing labels…". Both are hidden after the result message.
3. **E2E:**
   - after OK on "Replace labels?", once the bar shows, there is no `label-` or `mask` layer;
   - toggling Show labels doesn't bring them back;
   - on success, only the new mask layer exists.
4. **E2E:** a refused file (3 bands) after OK keeps the old labels, their layers and Undo's state, and the bar never shows.
5. **E2E, Cancel at window k:**
   - no window after k+1 is read;
   - "Import cancelled." shows;
   - every `tile(key)`, the class list, the layers and Undo's enabled state equal what they were before the import.
6. **Unit / E2E:** a read failure partway, and an "empty" import, restore the same way, with their usual messages.
7. **E2E:**
   - opening a raster during an import shows the discard confirm;
   - OK leaves no labels, no bar and no import message;
   - Cancel lets the import finish.
8. **E2E:** during an import, `#mode-paint` strokes, class edits, Undo, `#import-labels`, `#class-map` and `#export-labels` are disabled or ignored, and Opacity and Show labels work.
9. **Unit:** with imagery `nodata` null and integer samples, an import, a copy-on-touch tile and an export make no imagery reads, and their tiles are byte-equal to before. With nodata set, or with float samples, they read as before.
10. **Spec 014 criteria 4, 5, 9 and 10 and spec 019 criterion 4 still pass. `npm run check` passes.**
