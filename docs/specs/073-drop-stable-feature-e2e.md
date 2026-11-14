# 073: Drop the tests of stable features, and all one-off tests

**Status:** Accepted, final (Gage's answers, 2026-11-12, are below). **ADRs:** none. **Order:** 061 → 062 (PR #11) → 073 → 071 → 072. 073 waits for 062 because it deletes `tool-strip-tidy.spec.ts`, which 062 edits. Specs 071 and 072 shrink to what 073 leaves.

**Gage's rules:**
- **R1:** "Opening rasters imagery is stable, segmentation is stable and needs no testing, check others that can also be removed". "Segmentation" means all mask labelling: brush, erase, fill, polygon, Smart select and class masks. On smoke tests: "keep only smart select".
- **R2:** "Once a feature is created and tested, it needs no CI test everytime because it does not change." This covers "All one-off tests", unit tests included, and applies to existing work now.

Lists A, B and O below are approved. In list P, the rows Gage said yes to are approved; the rest stay.

**Baseline:**
- **E2E:** spec 061's suite (branch `spec-061-prune-stable-e2e`; CI run 43349765294): 231 tests in 67 files, counting the two `@ci-skip` tests and the skipped live test.
- **Unit:** 182 files in `tests/unit`, read on local `main` at 7032e4f.
- **Rerun before deleting:** main is now e74c20f (061 merged). The implementer reruns the rules below on current main at build time. **The rules decide, and the counts are estimates.**

## Gage's answers (2026-11-12)
1. **Q1, delete the testers he kept earlier.** These are the saved-data testers (`label-persist-lock.t`, `label-export-snapshot.t`, `label-lock-export.t`, `race-opens.t`; 8 tests) and the Smart testers (`smart-model.t`, `smart-model-live.t`, `right-click-discard.t`; 9 tests).
2. **Q2, rename and trim the testers that are their module's only unit cover.**
   - **Files:** `core/brush.tester`, `io/classMap.tester`, `io/labelFile.merge.tester`, `io/seedBuild.tester`, `io/seedTable.gdal.tester` and `io/segmenter.tester`. Also `io/pipeline.progress.tester`, if `pipeline.progress.test` is absent.
   - **Change:** each is renamed to `.test.ts` and keeps its 1–3 essential cases. The criteria each kept case guards are named in the commit.
3. **Q3, keep all Smart select e2e** (`smart-select`, `smart-model`).
4. **Q4, keep the import, seed and class-map e2e.**
5. **Q5, `.claude/agents/tester.md`:** Gage applies the text himself.
6. **P:**
   - **Yes:** navigation, status bar and help; the unit trims.
   - **No:** label view, keys and basemap; classes. These stay. `label-edit` 29 stays too, because its row wasn't approved.

## A: opening rasters and imagery (R1; 22 e2e tests, 8 files)
- **Files:** `open-progress`, `imagery`, `imagery.tester`, `raster-race`, `workflow`, `globe`, `steady-pan`, `flicker-probe` (@probe).
- **Unit cover that stays:** `io/pipeline*`, `io/geotiffSource*`, `io/blobSource*`, `io/imageryLoader*`, `core/imagery`, `map/imagery*`, `ui/imagery`, `core/warp*`, `core/decimate`, `core/lattice`, `core/crs`, `ui/steadyPan`.

## B: mask labelling (R1; 62 e2e tests, 17 files plus 3 partial)
- **Whole files:** `brush-stroke`, `brush-paint`, `brush-pan`, `brush-hover`, `brush-nodata`, `brush-scope`, `brush-slider`, `brush-180.t`, `brush-contextmenu-all.t`, `brush-handler-matrix.t` (with `handlerMatrix.ts`), `brush-space-focus.t`, `erase-any`, `tool-keys`, `fill-polygon`, `label-alignment`, `label-mask`, `cursor-lock`.
- **Single tests:** `label-edit` 10, `brush-panel` 20, 34 and 48 (brush size), and `undo` 76 (brush cursor).
- **Unit cover that stays:** `map/brush*`, `map/cursor`, `core/pixel`, `core/spans`, `core/nodata`, `core/fill`, `io/fill`, `ui/fill`, `core/holes`, `core/polygon`, `ui/polygon`, `core/labelStore*`, `core/labelQuads*`, `core/overlays`, `core/maskPreview`, `io/maskImport`, `io/paintQueue`, `io/maskCache*`, `map/quadCache`, `ui/labelDisplay`.
- **Dropped coverage:** `ui/brushSize.ts` (the size buttons and keys) has no unit test.

## O: one-off tests (R2)
- **Every remaining `*.tester.spec.ts`: 13 e2e files, 32 tests.** These are `class-map`, `label-lock-export`, `race-opens`, `label-export-snapshot`, `tool-strip-tidy`, `label-persist-lock`, `smart-model`, `smart-model-live`, `right-click-discard`, `undo-seed`, `save-folder`, `label-classmap-names` and `label-controls`. All are deleted, the 7 named in Q1 included.
- **Every `*.tester.test.ts`: 52 unit files.** The 7 named in Q2 are renamed and trimmed instead. Each of the other 45 has a base `.test.ts` for the same module, which stays.
- **Doc and structure checks:**
  - **Whole files:** `ui/readme.test.ts` (README and ADR text), `ui/style.test.ts` (CSS text), `lint.test.ts` (a one-time eslint ignore), and `ui/spec057.tester` (already in the tester list).
  - **Single `it`s that check source text for a one-time change:** `core/labelStore.nocap` (no `MAX_LABEL_TILES` in `src`), `core/pick` (a removed name appears nowhere), `ui/classPanel` and `ui/clickTools` (they read `labels.ts` as text).
  - **The one-off cases in `ci.test.ts`:** the `@ci-skip` case and the per-file `setTimeout` grep. `ci.test.ts` keeps its triggers, permissions, jobs and `@probe` guards.
- **One-off e2e:** `tool-strip-tidy.spec` (spec 056's one-time DOM and order tidy, 3 tests) and `shelf` 58 (the build has no terra-draw).

## P: Gage's extra areas (R1 logic: stable, not in a 062+ area, unit-covered)
| Area | Tests | Gage | Unit cover |
|---|---|---|---|
| navigation | 14 e2e | **Yes, delete** | `core/wasd`. **Dropped coverage:** `map/navigation.ts` (middle-button pan, WASD stops) has no unit test. |
| status-bar | 5 e2e | **Yes, delete** | `core/status` |
| shortcut-help | 4 e2e | **Yes, delete** | `ui/help`, `ui/shortcuts` |
| Unit trims: `io/pipeline.{edge,parallel,yield}`, `io/imageryLoader.{decimate,draws}`, `map/imagery.quads`, `io/{blobSource,geotiffSource,maskCache}.hold`, `io/maskCache.{task,windows}`, `io/nodata.{edge,inf.edge}`, `ui/persist.{amend,preview,retry}`, `core/warp.stretch`, `shelf.test`, `viteConfig.test`, and the `ui/shortcuts` text scans 49 and 152 | 19 files and 2 `it`s | **Yes, delete** | the base test of each feature |
| class-palette, class-picker, brush-panel 61 and 82 | 8 e2e | No, kept | |
| label-view, label-keys, basemap, space | 17 e2e | No, kept | |
| label-edit 29 | 1 e2e | Not approved, kept | |

## Kept
- **E2E:**
  - Smart select (`smart-select`, `smart-model`);
  - saved data (`label-persist`, `label-lock-edits`, `label-roundtrip`, `save-folder`, `import-folder`, `label-edit` 29);
  - import, seed and class map (`label-import`, `label-replace`, `label-import-progress`, `label-stale`, `undo-seed`, `class-map`);
  - undo and redo (`undo` 49 and 17, `redo`);
  - classes (`class-palette`, `class-picker`, `brush-panel` 61 and 82);
  - label view (`label-view`, `label-keys`);
  - `basemap`, `space`, `layout`, and `shelf` 20.
- **Unit:** every base `.test.ts` not named above, including `core/` maths, the stores, undo, fill, holes, boxes, the io round-trips, and `ci.test.ts`, plus the Q2 renames.

## Counts (estimates; the implementer measures them on current main)
| | Before | After |
|---|---|---|
| E2E tests (files) | 231 (67) | 88 (25) |
| Unit files | 182 | about 115: −52 testers, +7 Q2 renames, −3 doc files, −19 trims |

CI e2e time is a bit over a third of today's (88 of 231 tests, and the slowest groups go). The `check` job loses about 37% of its unit files.

## Acceptance criteria
1. **Deletions:** each approved row is deleted. No deleted e2e title remains in `--list`.
2. **No unused helpers:** no `*.tester.*` file remains. The Q2 files exist only under their `.test.ts` names. Every export in `tests/e2e/*.ts` and `tests/unit/helpers/*` is still imported somewhere (grep).
3. **Kept files unchanged:** kept files have an empty `git diff main...HEAD`, except the files with partial rows.
4. **Counts:** `npm run check` and `ci` are green. The CHANGELOG records the e2e and unit test counts before and after (from `--list` and the Vitest summary), and each shard's time.
5. **Docs:**
   - **Spec notes:** each spec named by a deleted test's title or header gets "e2e/unit tests removed by spec 073 (stable or one-off)", with its criteria. A grep over the deleted files' spec numbers checks every one has the note.
   - **CHANGELOG:** names the dropped coverage: dab alignment, `ui/brushSize`, and middle-button navigation and WASD stops.
   - **`.claude/agents/tester.md`:** Gage applies the coordinator's suggested text himself (Q5).
