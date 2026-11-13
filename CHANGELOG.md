# Changelog

One entry per merge to main, newest first. Details are in the named spec.

## 2026-11-12
- **Spec 061:** 94 e2e tests of stable features are deleted (325 → 231 listed, 319 → 229 on CI; 85 → 66 files), and the @ci-skip tests drop from 6 to 2. No app behaviour changes. One smoke test per feature stays. Kept although listed: the 6 spec 004 tests (`undo-seed.tester`, `label-controls.tester`, `label-lock-export.tester` 55, 75 and 99) and `label-edit` (2 tests), because spec 004's body changed after 2026-10-31; and 3 that took under 5 s on CI (`navigation` wheel and middle drag with no imagery, `status-bar` at 1280x720). Coverage lost, ⚠ where nothing else tests it:
  - Tier A: the WASD speed cap under key repeat; focus and visibility stops; a middle drag from the panel; Ctrl+Z mid-stroke; a class key during a lock; Space at lock end; overlays following each undo, and overlay recolour (local-only); hidden labels under import and export locks; a size change mid-stroke; navigation and import while the preview loads; out-of-order held opens; the transparency render; the next import not pre-cancelled; restored labels taking settings changed mid-import; contrast over the stars; a pitched horizon.
  - Tier B (brush edge cases): a right press mid-stroke, pinch, keyboard zoom, a blur ending a stroke, the clipped edge hover, MAX_LAT, and the 180° hover and world copy.
  - ⚠ spec 023 criterion 9 (one op per move, swept = per-cell) on a big file (`paint-latency`).
  - ⚠ the alpha band end to end (spec 022; `alpha`).
  - ⚠ rendering of 128-quad tiles, mask quads above the mask, and dab = hover on EPSG:4326 globes (`label-quads.tester`); spec 018 criteria 3 and 5 are checked on UTM only.
  - ⚠ seam colour (spec 011 criterion 6; `label-seams`).
  - ⚠ an open during an import, and Cancel then a failed read (spec 021; `label-import-progress`).
  - the not-allowed cursor during an Export (`cursor-lock`).
  - ⚠ opacity and brush size kept on an open, and Pan on load (spec 016 criteria 3 and 8; `label-view`).
  - ⚠ Pan-mode WASD with + focused, and pointercancel ending a middle pan (`navigation`).
- **Spec 063:** Boxes exist as data: axis-aligned, whole-pixel boxes in a class, held per open raster, with pure geometry for drawing, moving, resizing and hit-testing them. Undo and redo keep one history for mask strokes and box edits (ADR 0038, amending ADR 0015); each box change counts 48 bytes against the 32 MiB budget. Nothing visible changes until spec 064.
- **Spec 056:** The brush strip reads +, size, −, then the slider, so + sits above the end of the slider that means larger. The ✓ Apply button shows only in Smart select. The three file buttons in the top bar show no "No file chosen" text beside them.
  - `brush-panel` "recolouring changes the overlay and the hover colour" (run 43291075248): @ci-skip: not run on CI. On CI, nothing checks that recolouring a class repaints its overlay.
  - `labelDisplay.tester` "partial edge tiles get overlays; erasing an overlaid edge tile drops its overlay…" (run 43296016620): 30 s timeout: heavy on CI runners, spec 060 c11.
  - `fill-polygon` "Fill gives the clicked region of an imported mask…" (run 43310858328): @ci-skip: not run on CI. On CI, spec 054 criterion 10's fill, undo and redo of an imported mask isn't checked end to end.
- **Spec 059:** A Fill click also gives the selected class to each speck of up to 2 px that its region fully encloses, in the same edit and undo step. Specks of other classes count too. Nodata, specks touching the region's outside and specks at the edge of its reach stay as they are. Spec 054 (Fill and Polygon) is accepted as built.
- **Spec 058:** Erase (`E`) removes any label under the brush, whichever class is selected, by left or right drag; Paint's right drag and the pen barrel still remove only the selected class. In Erase mode the cursor is an eraser, the footprint is drawn dashed in white, and the status bar reads `Erase · 7 px`. Undo restores what an erase removed, imported mask pixels included.
- **Spec 060:** GitHub Actions CI runs `npm run check`, then the full e2e suite in 4 shards on Linux, on every PR to main and push to it; a merge waits for a green `ci` check (ADR 0036). Playwright uses 2 workers, and `npm run e2e:changed` runs only the e2e files a branch touches. No app behaviour changes. 13 e2e tests that measured machine speed or duplicated other tests are deleted (spec 060 criterion 14). This drops coverage of a stroke lifted when it leaves the globe (brush-gaps 73), spec 048 criterion 7 end to end (no-tile-limit), WASD and a middle drag panning during an import (undo-seed.tester 30), and the 1 s redraw bound (steady-pan).
  - `brush-scope.tester` "another raster opened while mask reads are paused drops the queue…" (run 43181863257): @ci-skip: not run on CI.
  - `class-map` "apply renames and recolours by raw value…" (run 43181863257): @ci-skip: not run on CI. On CI, nothing checks the mask's repainted pixel colour.
  - `undo` "three undos by button restore the store…" and "three undos by Ctrl+Z restore the store…" (run 43181863257): @ci-skip: not run on CI. On CI, nothing checks that the overlays follow each undo.
  - Branch protection on main (set by Gage, 2026-11-12): a PR and the `ci` check are required, admins can bypass, and force-push and deletion are off.

## 2026-11-11
- **Spec 055:** Smart select needs no setup step: choosing it downloads the 78 MB model from Hugging Face once (after a confirm) and keeps it in the browser's cache. A wrong or failed download is never cached, and any load failure shows one popup, "Smart select isn't available on this device.", with the cause in the browser console. `npm run fetch-model` is removed.
- **Spec 057:** `npm run check` passes on main again: the README tests keep only what the shortened README still says, Undo and Redo tooltips are tested for both Mac and other platforms, and e2e undo presses use Cmd on macOS. Tool tooltips show what the button does under its key, with new Paint, Erase, Smart select and Fill texts. E2E was run on the 10 affected files (62 passed); the full suite is to run in CI (spec 060).

## 2026-11-03
- **Spec 053:** On Chrome and Edge, Import labels opens its chooser in the imagery's folder (when the imagery came through Open GeoTIFF's picker) instead of the last folder used; the import itself, its replace confirm and other browsers are unchanged.
- **Spec 052:** The e2e suite is pruned and shrunk: 60 redundant or obsolete tests are removed (361 → 301) and the slowest ones compare stored tile bytes or read only the pixels they check, so a run takes about a third less time and no test takes over 30 s. No app behaviour changes.

## 2026-11-02
- **Spec 051:** Import labels reads class tables written by GDAL or rasterio (which escape the XML twice), so pseudo-labels made in Python import with their class names and colours instead of "Class N"; files the app exported read as before.
- **Spec 050:** On Chrome and Edge, Open GeoTIFF uses the browser's file picker, so Export labels opens its Save dialog in the imagery's own folder (suggesting `labels.tif`) instead of the last folder used; other browsers are unchanged (ADR 0034).
- **Spec 049:** In Smart select a right click discards the pending selection (points and preview) without leaving Smart mode, so you can start again quickly; exclude points move to Shift+click. A right drag still rotates the map, and Ctrl+Z still undoes an applied fill.

## 2026-11-01
- **Spec 048:** Painting, mask edits and smart-select fills are never refused for a tile limit, so a whole chunk can be labelled; at most 256 tiles nearest the view's centre draw at full resolution, the rest on the preview layer, and the latest edit stays undoable however large.
- **Spec 047:** Import labels never fails on a class table: bad entries in a file's table are skipped and named in the message, and values it doesn't name import as "Class N". The optional **Apply class map** now comes after Import labels and renames and recolours the loaded classes by value without touching any pixels.
- **Spec 046 Amendment A:** Smart select no longer shows low-confidence masks that flood the area: it picks the most confident mask among those with stable edges, and logs each mask's scores to the browser console.

## 2026-10-31
- **Spec 046:** Smart select (M): click points on the imagery and SAM 2.1 Tiny, running locally on WebGPU, proposes a mask to fill with the selected class; Enter applies it, Escape discards it. Fetch the model once with `npm run fetch-model` (replaced by spec 055: the model now downloads from Hugging Face on first use).
- **Spec 045:** The top of a zoomed, tilted map no longer flickers navy: the basemap stops drawing from zoom 12, leaving plain navy ground outside the raster. Holding ? no longer flickers the help list, macOS tooltips say Cmd, and Ctrl+Shift+Z also redoes on macOS.

## 2026-10-30
- **Spec 039:** ? or the top-bar button lists every shortcut (other shortcuts pause while it is open), buttons show their keys in tooltips, and a class pick still reading is cancelled when another raster or label file opens.
- **Spec 038:** Alt+click a pixel, or press I while hovering, to select its class without leaving the current tool; a failed read of an imported mask shows the error.
- **Spec 037:** Redo (button, Ctrl/Cmd+Shift+Z, Ctrl+Y) brings back undone strokes within the shared 32 MiB undo budget, and Home works with a checkbox focused.
- **Spec 036:** Each class row shows its key number, a colour swatch and its name; renaming takes the pencil button or a double-click (Enter saves, Esc cancels), so typing a shortcut can't change a name, and the list fills the panel and scrolls the selected class into view.
- **Spec 035:** The app is laid out in regions: file actions in a top bar, tools in a left strip, classes and label view in a right panel, and the status bar below; \ collapses both side panels (remembered), and Home or the ⌂ button zooms back to the raster.
- **Spec 034:** H shows or hides labels, and holding ` hides them only while held without changing the tool (no stroke starts during it); opening a raster mid-stroke no longer flashes a queued tool.
- **Spec 033:** B paints, E erases and P or Esc pans; a new **Erase** mode lets a left drag erase the selected class (dashed brush outline), and a key pressed mid-stroke takes effect when the stroke ends.
- **Spec 032:** A status bar along the bottom shows the cursor's lon/lat and raster pixel, the zoom, the current tool, save state, messages (errors in red) and progress with Cancel; a failed save retries every 30 s, a full disk no longer re-copies an imported mask, and opening another raster asks "Close these labels? They stay saved in this browser."
- **Spec 031:** Labels, classes and view settings are saved in this browser as you work (2 s after you stop, and at once when the tab is hidden or closed), and reopening the same raster offers to restore them, imported mask included; the page warns before closing only while something is unsaved.
- **Spec 030:** Opening a raster projects a sparse, self-checked grid of preview points instead of every pixel, with byte-identical results, so a typical chunk draws its preview in about 0.36 s (was 0.68 s) with no pause over 75 ms, and importing labels no longer has its 340 ms pause.
- **Spec 024:** Importing a label mask reads the label file once in a single pass and the imagery only where needed, without freezing the page: a typical chunk imports in about 3 s (was 69 s), Chunk 11 in 28 s (was about 21 min), the tiled 20000² chunk in 55 s (was about 10 min), and painting right after an import stays smooth.
- **Spec 028:** Loading imagery no longer freezes the page: uncompressed files read only the columns each tile needs (Chunk 11 reads 3 MB instead of 113 MB at full zoom), compressed files decode in small pieces, and drawing yields to the browser every 8 ms; a typical chunk now fills mid zoom in about 0.4 s with no pause over 50 ms.
- **Spec 029:** Tidy-ups from reviews: tiles that partly fail to project no longer fall back to slow placement, the tile-position cache is capped, opening a raster mid-pan waits for the pan to stop, and three intermittently failing tests are fixed.
- **Spec 027:** Holding W/A/S/D pans smoothly without reading the file mid-pan; full-resolution detail loads once you let go, and other bursts of map moves load once they settle.
- **Spec 026:** Imagery and label tiles are placed on the map from a sparse grid of projected points instead of every pixel corner, so filling the view at mid zoom takes about 0.7 s on a typical chunk (was 2.8 s before specs 025–026) and 1.0 s on the largest.
- **Spec 023:** Painting is much smoother: after a raster opens its valid-pixel masks are read once in the background and kept, each pointer move paints as one sweep, and label tiles near the brush are prepared while idle; a large brush on the largest chunk went from about 1.5 s lag to under 0.1 s.
- **Spec 025:** Opening a raster and loading detail read neighbouring parts of the file together, so a typical chunk now shows its preview in about 0.9 s instead of 2.7 s and full-resolution tiles in about half the time.
- **Spec 022:** Transparent pixels in an image with an alpha band now show as see-through and take no labels, and imports read the imagery a row at a time.
- **Spec 021:** Importing labels shows a progress bar with Cancel; the old labels leave the map while it runs and come back if it's cancelled, fails or finds nothing.

## 2026-10-29
- **Spec 020:** Zooming in now shows the imagery at full resolution, loaded tile by tile for the area in view, with the preview filling in until tiles arrive; memory stays bounded (about 530 MiB at worst), and if part of a file can't be read you see "Couldn't read part of this file, so some detail may be missing."
- **Spec 019:** A progress bar shows while a raster opens, Paint stays unavailable until the imagery is drawn, a file that can't be read now says so, and opening another file stops the previous one's reads.
- **Spec 016 (amended):** Clearing Show labels now switches to Pan instead of blocking the brush, and choosing Paint shows the labels again.
- **Fix (spec 018):** Painted labels now land exactly on the image pixels under the brush outline; before, the colour could spill up to a pixel outside it, in a direction that changed across the image.
- **Specs 016–017:** An Opacity slider and a Show labels checkbox control how labels are drawn; painting is blocked while labels are hidden, and opening a raster switches to Pan. The brush size is a slider from 1 to 127 px (odd sizes; −/+ and `[`/`]` halve or double it), Seed mode is gone, and every import replaces the labels after a confirm.
- **Spec 014:** You can import a label mask of any size and fine-tune it with the brush; areas you haven't painted are read from your file as needed. Imports always replace the current labels, can't be undone, and switch the map to Pan.
- **Spec 013:** AlphaEarth, training and model seeding are gone from the app; their code is kept unused in `shelf/`. The area tool is gone too.

## 2026-10-28
- **Spec 015:** A starfield shows around the globe.
- **Specs 009–012:**
  - Wheel zoom is centred on the map, and you can pan with a middle-button drag or WASD.
  - The brush cursor shows the label colour, and Undo/Ctrl+Z undo strokes.
  - Label tiles no longer show seams or strips.
  - A low-res world basemap is bundled with the app.
- **Fix:** Unit tests pass on Windows with Node 24. The AEF index script no longer overwrites a stray file on Windows.
- **Spec 004:** Import labels from a classified GeoTIFF, or seed them from a model, then export them as a label GeoTIFF that imports back unchanged. Seeding from a model is now shelved by spec 013.

## 2026-10-27
- **Spec 003:** Label local imagery with a paint brush.
- **Spec 002:** Classify with AlphaEarth embeddings. Now shelved by spec 013.

## 2026-10-26
- **Spec 001:** First classifier: logistic regression on labelled pixels. Now shelved by spec 013.
