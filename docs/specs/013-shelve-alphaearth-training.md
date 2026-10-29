# 013: Shelve AlphaEarth and model training; the site is for labelling

**Goal:** The site does only local-imagery labelling: open, preview, brush, classes, undo, import and export labels, navigation and basemap. The AlphaEarth and training code moves, unused, to `shelf/`, outside the app's import graph.

**Status:** Approved (Gage, 2026-10-28). Build on `feat/009-012-nav-undo-seams-basemap` (specs 009-012), after it merges. **ADRs:** 0017 shelf (Accepted).

**Decided (Gage, 2026-10-28):** "remove alphaearth and model training from the site. It is out of the current scope. We are just trying to get labelling right." "Just hide the code from the UI by placing the code unused in a separate folder." Then accepted: `shelf/` stays outside `npm run check` and terra-draw is removed; an AlphaEarth file given to Open GeoTIFF opens as ordinary 64-band imagery; spec numbers 006-008 stay unused (spec 002 and ADR 0012 cite them). `CLAUDE.md` was updated with this approval, so this change leaves it alone.

## Scope
**In:** removing the UI; moving the code, tests, fixtures, scripts and the catalog index to `shelf/`; removing terra-draw; dropping the AlphaEarth refusal in Open GeoTIFF; updating README and status lines.

**Out:** deleting shelved logic (wiring and the shelved steps of mixed e2e tests are dropped; git history holds them); changing labelling behaviour, except where the rules below say a lapsed clause goes.

## Interfaces
No new `core/` function. `shelf/` mirrors the repo: a file keeps its path under `shelf/` (`src/core/aef.ts` becomes `shelf/src/core/aef.ts`) and keeps its imports unchanged, so moving it back is the whole revival. `shelf/README.md` (≤10 lines) is for whoever revives this code. It says what is here, names the last commit where it ran wired (the parent of this change), and gives the dependencies to restore: terra-draw 1.38.0 and terra-draw-maplibre-gl-adapter 1.5.0.

**Rules.**
- **Moves whole.** `src/core/`: aef, aoi, mosaic, flip, fit, labelSamples, modelio, validate, predict. `src/io/`: aefCache, aefDownload, aefIndex, aefLocal, aefPreview, aefRemote, rangeGet, rangeSource, decodedTiles. `src/map/`: draw, aefPreview. `src/ui/aef.ts`.
- **Split modules.** Only the parts nothing in `src/` uses after the move go to the same path under `shelf/`, as fragments to merge back by hand, with copies of the private helpers they call:
  - `core/types.ts`: `Model`, `EPS` (`NODATA_OUT` stays; the tiff writer uses it).
  - `io/pipeline.ts`: `train`, `checkClassify`, `classify` and their helpers. `openRaster` and `buildPreview` stay.
  - `io/seeding.ts`: `seedModel` (with a copy of `build`); `SeedOutcome` loses `"bad names"`.
  - `io/geotiffSource.ts`: AlphaEarth detection, dequantizing and `GeoTiffSource.aef`.
  - Exports that become unused: `classes.badClassName`, `geotags.northUpAffine`, `labelStore.labelWindows`, and any other the reviewer finds.
- **Wiring is not shelved.** `ui/main.ts` (Train, Classify, Save and Load model, AlphaEarth and terra-draw setup, the `rasterIsAef` refusal), `ui/seeding.ts` (Seed from model, Min. confidence, the model and training deps), `ui/labels.ts` (`onPaint`'s `draw.setMode`), model and AlphaEarth strings in `ui/messages.ts`, and in `index.html` the "AlphaEarth embeddings" and "Model" fieldsets, `seed-model` and `min-confidence`. `map/layers.ts` loses the `aef-preview` and `td-` slots. The `__geoapp` hook loses `draw`, `aef` and `model`. Comments in kept files that cite terra-draw (`map/brush.ts`, `map/layers.ts`, `map/navigation.ts`, `ui/style.css`) are reworded; behaviour is unchanged.
- **Kept.** Everything else in `src/`, including the tiff writer (GDAL_NODATA "255" default). Import labels keeps Class map and Seed mode (Merge or Replace).
- **Tests.**
  - Move to `shelf/tests/`, same relative path: tests whose subject is shelved, with their helpers and fixtures. Unit: `aef*`, `aoi*`, `mosaic`, `flip`, `fit*`, `labelSamples`, `modelio`, `model.edge`, `predict`, `validate`, `seedModel*`, `cogOrientation*`, `range*`, `pipeline.brush.tester`, `scripts/buildAefIndex*`; helpers `aef*`, `fakeLocks`, `fakeOpfs`, `floats`, `fileReader`, `rangeFetch`. E2e: `aef*` (specs and the helpers `aef.ts`, `aefTabs.ts`, `aefTester.ts`), `brush-train*`, `classify-busy`, `export-guard`, `race-classify`, `race-train`, `label-seed-model`. Fixtures: `tests/fixtures/aef/` and `tests/fixtures/aef-index/`.
  - Mixed tests keep their kept assertions. Unit assertions on shelved functions go to the same path under `shelf/tests/`; shelved e2e steps are dropped. Unit: `classes`, `geotags`, `labelStore`, `brush.tester`, `geotiffSource`, `pipeline`, `pipeline.edge`, `nodata.edge`, `nodata.inf.edge`, `seedImport`, `seedReads`, `seedBuild.tester`, `labelExport.tester`, `ui/messages`. E2e: `basemap`, `navigation`, `nav-undo.tester`, `workflow`, `raster-race`, `race-opens.tester`, `undo`, `undo-seed`, `brush-*` (edge, handlers, handler-matrix, contextmenu-all, nodata, pan, scope, space-focus), `label-*` (edit, controls, merge, stale, classmap-names, import, lock-seed-train), and the helpers `helpers.ts`, `lockCombos.ts`, `raceCombos.ts`, `handlerMatrix.ts`, `seeding.ts`.
  - Kept tests stop using shelved things: `logRequests` is copied into `tests/e2e/helpers.ts`; `settled` waits for `#import-labels` to be enabled (disabled while strokes wait for masks) instead of `#train`; the 8-bit refusal in `label-import` and `seedImport` uses criterion 8's generated file instead of `tests/fixtures/aef/`; focus cases on `#aef-year` use a kept control of the same kind (a class name field, or `#seed-mode` once labels exist), else are dropped.
  - The implementer's report lists each test moved or edited.
- **Other files.** `scripts/build_aef_index.mjs` and `scripts/fixtures/` go to `shelf/scripts/`, and `eslint.config.js` loses its `scripts/` block. `public/aef-index/` goes to `shelf/public/aef-index/`, because Vite copies `public/` into every build. terra-draw and its adapter leave `package.json`; `@types/geojson` stays (`map/hover.ts`). `eslint.config.js` ignores `shelf/`. tsconfig, Vitest and Playwright already cover only `src`, `tests` and `tests/e2e`.
- **Specs and ADRs** stay where they are. Their Status lines gain, in this change:
  - Specs 002 and 005, and ADRs 0003, 0005, 0006, 0007, 0008 and 0011: "Shelved by spec 013 (2026-10-28)". Add "never built" to 005. ADR 0012: the same, except option (iii), importing a classified GeoTIFF, which holds.
  - Partly shelved, naming the lapsed parts: spec 001: all but raster open, preview, globe, and criteria 1, 4, 12's globe checks and 16; spec 003: Training, the AOI clause, the AlphaEarth refusal and layer, and criteria 15, 17's training part and 19's Train part; spec 004: Seed from model, Min. confidence, Train locks, and criteria 5, 17, 18's Train part and 15's AlphaEarth case; spec 009: the area tool; spec 010: the Train and model-seed clauses; spec 012: AlphaEarth layers and controls; ADR 0001: classification output; ADR 0009: terra-draw; ADR 0010: Train's snapshot; ADR 0015: Train's 16 MiB.
  - README describes labelling only.

## Acceptance criteria
1. UI (e2e): no element has id `train`, `classify`, `save-model`, `load-model`, `seed-model` or `min-confidence`, or an id containing `aef`; the panel's text contains neither "AlphaEarth" nor "model" (case-insensitive).
2. Import graph (unit): no file under `src/` or `tests/` has an import specifier containing `shelf/`, `terra-draw` or `fixtures/aef`. After `npm run build`, no file in `dist/` contains "terra-draw", "source.coop" or "aef-index", and `dist/aef-index/` doesn't exist.
3. `package.json` has no `terra-draw` or `terra-draw-maplibre-gl-adapter`; `npm run check` passes; `eslint.config.js` ignores `shelf/`.
4. Shelf (script, run once by the tester): every file named in Rules as moving exists under `shelf/` and not at its old path. Every relative import in a moved file resolves either to another file under `shelf/` or, after mapping `shelf/` back to `/`, to a file present now. `shelf/README.md` names the commit and both dependency versions.
5. Layers (e2e): after opening the RGB fixture and painting, `getStyle().layers` ids are, in order, `background`, `basemap`, the imagery preview, label overlays, then hover. No layer or source id contains `aef` or starts with `td-`.
6. Privacy (request log, e2e): from page load through open, paint, undo, import, export and opening another raster, every request goes to the app's origin under its base path, and none ends in `.json` under `aef-index`.
7. Kept (e2e): spec 003 criteria 1-14, 16, 18 and 19 (without Train), spec 004's import and export criteria (1-4, 6-16 and 19, without the shelved parts), and specs 009-012 (without the area tool and AlphaEarth parts) pass unchanged.
8. AlphaEarth-shaped file (e2e): opening a 64-band Int8 GeoTIFF with GDAL_NODATA -128, generated by the test, shows "64 band(s)" in the raster info and the brush panel. Importing it as labels shows "Label files must be single-band 8-bit GeoTIFFs."
9. Docs: each spec and ADR named in Rules has the given Status text, and README contains neither "AlphaEarth", "Train" nor "Classify".
