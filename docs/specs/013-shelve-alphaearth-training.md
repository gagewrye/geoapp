# 013: Shelve AlphaEarth and model training; the site is for labelling

**Goal:** The site does only local-imagery labelling: open, preview, brush, classes, undo, import and export labels, navigation and basemap. The AlphaEarth and training code moves, unused, to `shelf/`, outside the app's import graph.

**Status:** Draft. Build on `feat/009-012-nav-undo-seams-basemap` (specs 009-012), after it merges. **ADRs:** 0017 shelf (Proposed).

**Decided (Gage, 2026-10-28):** "remove alphaearth and model training from the site. It is out of the current scope. We are just trying to get labelling right." "Just hide the code from the UI by placing the code unused in a separate folder."

**Open questions (Gage).**
1. Should `shelf/` stay out of `npm run check` (recommended, ADR 0017), or keep being typechecked and tested? Keeping it in means keeping terra-draw installed, and every label-store change (spec 014) must keep Train compiling.
2. `CLAUDE.md` is yours to edit. Proposed Layout line: `shelf/  AlphaEarth and training code, unused and outside npm run check (spec 013); reviving any of it needs a spec`. The intro also still says the app fetches AlphaEarth and that we host a catalog index (ADR 0005). `core/`'s line still lists "training, inference, model I/O".
3. An AlphaEarth COG given to "Open GeoTIFF" is refused today, with a message pointing to controls that no longer exist. Proposed: drop the special case, so it opens as ordinary 64-band imagery.
4. Numbers 006-008 were reserved by ADR 0012 for shelved work (GPU inference, change detection and change prediction). Proposed: don't reuse them, because spec 002 and ADR 0012 still cite them. New work continues at 013.

## Scope
**In:** removing the UI; moving the code, tests, fixtures, scripts and the catalog index to `shelf/`; removing terra-draw; updating README and status lines.

**Out:** deleting anything; changing labelling behaviour, except where the rules below say a lapsed clause goes.

## Interfaces
No new `core/` function. `shelf/` mirrors the repo: a file keeps its path under `shelf/` (`src/core/aef.ts` becomes `shelf/src/core/aef.ts`) and keeps its imports unchanged, so moving it back is the whole revival. `shelf/README.md` (≤10 lines) is for whoever revives this code. It says what is here, names the last commit where it ran wired (the parent of this change), and gives the dependencies to restore: terra-draw 1.38.0 and terra-draw-maplibre-gl-adapter 1.5.0.

**Rules.**
- **Moves whole.**
  - `src/core/`: aef, aoi, mosaic, flip, fit, labelSamples, modelio, validate, predict.
  - `src/io/`: aefCache, aefDownload, aefIndex, aefLocal, aefPreview, aefRemote, rangeGet, rangeSource, decodedTiles.
  - `src/map/`: draw, aefPreview.
  - `src/ui/aef.ts`.
- **Split modules.** Only the parts nothing in `src/` uses after the move go to the same path under `shelf/`:
  - `core/types.ts`: `Model`, `EPS`.
  - `io/pipeline.ts`: `train`, `checkClassify`, `classify` and their helpers. `openRaster` and `buildPreview` stay.
  - `io/seeding.ts`: `seedModel`.
  - `io/geotiffSource.ts`: AlphaEarth detection, dequantizing and `GeoTiffSource.aef`.
  - Any export that becomes unused, e.g. `classes.badClassName`, `geotags.northUpAffine`, `labelStore.labelWindows`. The reviewer checks this.
- **Wiring is not shelved.** Git history holds it. This covers `ui/main.ts` (Train, Classify, Save and Load model, AlphaEarth and terra-draw setup), `ui/seeding.ts` (Seed from model, Min. confidence, the model and training deps), `ui/labels.ts` (`onPaint`'s `draw.setMode`), model and AlphaEarth strings in `ui/messages.ts`, and in `index.html` the "AlphaEarth embeddings" and "Model" fieldsets, `seed-model` and `min-confidence`. `map/layers.ts` loses the AlphaEarth preview slot. The `__geoapp` hook loses `draw`, `aef` and `model`.
- **Kept.** Everything else in `src/`: crs, decimate, warp, grid, pixel, nodata, labelStore, classes, classTable, seed (import), overlay, undo and wasd. Also the tiff writer (it still defaults to GDAL_NODATA "255"), labelFile, labelExport, paintQueue, undoHistory, sink, navigation, cursor, hover, brush, labelOverlay, style and basemap. Import labels keeps Class map and Seed mode (Merge or Replace).
- **Tests.**
  - These move to `shelf/tests/`, same relative path: unit and e2e tests whose subject is shelved, their helpers (`aef*`, `fakeLocks`, `fakeOpfs`, `rangeFetch`) and `tests/fixtures/aef{,-index}/`. Examples: `aef*`, `aoi*`, `mosaic`, `flip`, `fit*`, `labelSamples`, `modelio`, `model.edge`, `predict`, `validate`, `seedModel*`, `cogOrientation*`, `range*`, `buildAefIndex*`, `brush-train*`, `classify-busy`, `race-classify`, `race-train`, `label-seed-model`.
  - Mixed tests lose only their shelved assertions. Examples: `label-lock-seed-train`, `undo-seed`, `basemap`, `navigation` (area tool), `workflow`.
  - The implementer's report lists each test moved or edited.
- **Other files.** `scripts/build_aef_index.mjs` and `scripts/fixtures/` go to `shelf/scripts/`. `public/aef-index/` goes to `shelf/public/aef-index/`, because Vite copies `public/` into every build. terra-draw and its adapter leave `package.json`; `@types/geojson` stays (`map/hover.ts`). `eslint.config.js` ignores `shelf/`. tsconfig, Vitest and Playwright already cover only `src`, `tests` and `tests/e2e`.
- **Specs and ADRs** stay where they are. Their Status lines gain the following, in this change:
  - Specs 002 and 005, and ADRs 0003, 0005, 0006, 0007, 0008 and 0011: "Shelved by spec 013 (2026-10-28)". Add "never built" to 005.
  - ADR 0012: the same, except option (iii), importing a classified GeoTIFF, which holds.
  - Partly shelved, naming the lapsed parts:
    - spec 001: all but raster open, preview, globe, and criteria 1, 4, 12's globe checks and 16;
    - spec 003: Training, the AOI clause, the AlphaEarth refusal and layer, and criteria 15, 17's training part and 19's Train part;
    - spec 004: Seed from model, Min. confidence, Train locks, and criteria 5, 17, 18's Train part and 15's AlphaEarth case;
    - spec 009: the area tool;
    - spec 010: the Train and model-seed clauses;
    - spec 012: AlphaEarth layers and controls;
    - ADR 0009: terra-draw;
    - ADR 0010: Train's snapshot;
    - ADR 0001: classification output.
  - README describes labelling only.

## Acceptance criteria
1. UI (e2e): no element has id `train`, `classify`, `save-model`, `load-model`, `seed-model`, `min-confidence` or `aef-*`, and the panel's text contains neither "AlphaEarth" nor "model" (case-insensitive).
2. Import graph (unit): no file under `src/` or `tests/` has an import specifier containing `shelf/` or `terra-draw`. After `npm run build`, no file in `dist/` contains "terra-draw", "source.coop" or "aef-index", and `dist/aef-index/` doesn't exist.
3. `package.json` has no `terra-draw` or `terra-draw-maplibre-gl-adapter`; `npm run check` passes; `eslint.config.js` ignores `shelf/`.
4. Shelf (script, run once by the tester): every file named in Rules exists under `shelf/` and not at its old path. Every relative import in a moved file resolves either to another file under `shelf/` or, after mapping `shelf/` back to `/`, to a file present now. `shelf/README.md` names the commit and both dependency versions.
5. Layers (e2e): after opening the RGB fixture and painting, `getStyle().layers` ids are, in order, `background`, `basemap`, the imagery preview, label overlays, then hover. No layer or source id contains `aef`.
6. Privacy (request log, e2e): from page load through open, paint, undo, import, export and opening another raster, every request goes to the app's origin under its base path, and none ends in `.json` under `aef-index`.
7. Kept (e2e): spec 003 criteria 1-14, 16, 18 and 19 (without Train), spec 004's import and export criteria (1-4, 6-16 and 19, without the shelved parts), and specs 009-012 (without the area tool and AlphaEarth parts) pass unchanged.
8. If Gage accepts open question 3: opening a 64-band Int8 GeoTIFF with GDAL_NODATA -128, generated by the test, shows "64 band(s)" in the raster info and the brush panel. The test doesn't use the shelved fixtures.
9. Docs: each spec and ADR named in Rules has the given Status text, and README contains neither "AlphaEarth", "Train" nor "Classify".
