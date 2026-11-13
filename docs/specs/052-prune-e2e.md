# 052: Prune and shrink the e2e suite

**Status:** Approved (Gage, 2026-11-02: "approved, and yes check the brush-scope flake"). All amended criteria are accepted; none are kept. The brush-scope check: the tester ran `brush-scope.tester.spec.ts:38` 4 times (once in the full suite, then 3 with `--repeat-each`), and all 4 passed, so the test stays. It may still be fragile under load: it sets its read gate after a fixed `waitForTimeout(1000)`, then asserts `__gate.reads` is exactly 1, so a late imagery read could fail it. A fix would be a follow-up, outside this spec. Criterion 4 accepted as measured (Gage, 2026-11-03: "Accept and merge", rather than re-timing on an idle machine or cutting more). The measurement ran on a loaded machine (CPU about 100%): 301 tests, 2,504 test-seconds (limit 2,100), 234 s wall (3.9 min; limit 3.3 min), no test over 30 s. Main under the same load: 3,902 test-seconds, 5.9 min. **ADRs:** none (no dependency, no architecture change). **Baseline (2026-11-02, 12 workers):** 361 tests, 3,335 test-seconds, 5.1 min wall. The wall time is throughput-bound (3,335 / 12 = 278 s), so test-seconds are what to cut.

**Amended by spec 061 (2026-11-12):** many tests this spec names as still covering are deleted, among them `nav-undo.tester`, `label-view.tester`, `label-view-pan.tester`, `label-quads.tester`, `alpha`, `label-seams` and `label-view` 95 (see spec 061). The 4326 dab = outline check is gone; `label-alignment` 79 checks UTM only.

**Goal:** `npm run e2e` runs in about 3 minutes, and no core flow loses its last e2e test.

## Delete (60 tests). R = redundant, N = no longer necessary, S = slow, low importance
| File: test (line) | | Why, and what still covers it |
|---|---|---|
| imagery: 49 checkerboard, 68 paint edges | R | `imagery.tester` 69 and 88 test the same things on a rotated UTM grid, which is the harder case |
| label-alignment: the 4326 45°N and 60°N cases of 79 | S | 142 s. `label-quads.tester` 130 checks dab = outline at 45°N and 84°N; unit `labelQuads*` check the quad math |
| label-mask 96 (export, reopen, import) | R | `label-roundtrip` 7 (byte-equal tiles and class list), `label-edit` 61 (no requests), unit `io/maskExport` (the export equals the effective tiles) |
| smart-select 107 (256 stored tiles) | R | `no-tile-limit` 41 (323 stored tiles, a smart commit labels a new tile, no error) |
| label-edit 14 (erase and paint over an import) | R | `label-mask` 56 (a paint and an erase over the imported mask) |
| label-import 38 (0/3/7 and 0/3/7/255 classes) | R | `label-replace` 36 and `label-mask` 218 assert the same class lists |
| brush-panel 127 (Add disabled at 255) | S | 21 s, 253 clicks. Unit `ui/classPanel` 81 |
| basemap 118 (not hideable) | N | Spec 012 criterion 6 names the AlphaEarth preview and the area tool, which are gone. Layer order: `basemap` 75, `label-alignment` 125 |
| nav-undo 241 (pans request nothing) | R | `basemap` 95 |
| nav-undo 47 (WASD in Pan mode) | R | `navigation` 204 "none" (Pan is the default mode) |
| nav-undo 83: the Control and Alt keydown stoppers | R | `navigation` 249 (Shift). All four keys take the same `MODIFIERS` branch (`map/navigation.ts:72`) |
| navigation 48, 67, 84: the "pan" cases | R | The middle button and the wheel don't depend on mode; the "paint" and "none" cases stay |
| navigation 268: the Alt and Meta cases | R | The Control case. The same check is on `map/navigation.ts:73` |
| nav-select.tester (both tests) | N | The app has no `<select>` since spec 017. The class-name cases in `navigation` 255 and `nav-undo` 83 use the same `typing()` path |
| brush-handlers.tester (all 3) | R | `brush-pan` 151 (handlers stay off after paint and erase strokes) and the matrix's Paint case. Test 55 only records a value |
| brush-pan 194 (double-click), brush-input 42 (Shift-drag) | R | The matrix's Paint case (`dblclick` and `boxZoom` false) |
| brush-input 88; brush-contextmenu.tester 26, 46, 97 | R | `brush-contextmenu-all` 49 (Paint, Pan) and 58 (the panel within 500 ms of an erase) |
| brush-contextmenu-all 49: the "another raster opened" case | S | 14 s; the listener doesn't depend on the open |
| brush-space-focus 37 (Shift+Tab), 50 (Tab through the panel) | R | `brush-pan` 69 and 102. Test 50 is the known failure: it Tabs twice from Paint expecting `#brush-smaller`, but spec 046 put Smart and Apply in between. **Delete, don't fix** |
| brush-handler-matrix: "Pan, then Paint" | R | It ends in the same state as the "Paint" case |
| brush-hover 30: zoom 9 | R | The zoom 3 and zoom 14 cases |
| label-view.tester 33, 75, 88, 120 | R | `label-view` 184, 159, 55 and 72; the even-value snap is the browser's own range behaviour |
| label-view.tester 109 (brush size kept on open) | R | Its two asserts move into `label-view` 95, which already opens another raster |
| label-view-pan.tester 141, 191 | R | `label-view` 184 (hiding mid-stroke) and 213 (Paint while hidden shows labels) |
| undo-seed.tester 31, 43, 53 | R | `undo-seed` 36, `label-import-progress` 136, `label-mask` 56 |
| raster-race 16 | R | `race-opens.tester` 8 does the same, with labels |
| label-controls.tester 57 | R | `label-import-progress` 166 (Cancel at Discard lets the import finish) |
| save-folder.tester 74, 117, 127, 138, 147, 159 | R | `save-folder` 64-116 (each failure, cancel and input case), unit `io/sink` |
| label-lock-seed-train.tester (whole file) | N | Its seed and Train cases went with spec 013. The rest: `label-export-snapshot.tester` 24, unit `io/maskExport` |
| flicker-probe 71, 86 (the two tests without @probe) | R | Unit: `basemap` `maxzoom` (spec 045 criterion 3); `basemap` 63 at `BASEMAP_MAXZOOM − 0.1`. The @probe tests stay |
| shelf 25, 38; workflow 5 | N/R | Spec 013's one-off removal (unit `shelf` guards it), layer order (`label-alignment` 125), and `shelf` 56 (every request stays on the origin) |
| class-palette 53 (Home in the slider) | R | `redo` 41 and `layout` 73 |

## Keep, but shrink
1. **Full-mask comparisons.** `label-mask` 56 and 148, `label-persist` 76 and `alpha` 19 call `labels()` on the 1000² mask, which builds a 750k-entry map on each call (111, 22, 83 and 37 s). They compare `effectiveTiles()` bytes instead, or sample, with the same expectations. `label-persist` 76 keeps the export-equality check.
2. **`label-alignment` 79:** the EPSG:32633 case only, at the first 10 of `positions()`.
3. **`imagery` 112 (tile cap, 73 s):** unit `map/imagery` already checks the 512 cap. The e2e test loads a few tiles of the checkerboard, opens another raster, and checks that every `imagery-` source is removed.
4. **`imagery.tester` 69 and 88:** read only the canvas window they sample (about 100 device px), not a full frame per poll.
5. **`brush-handler-matrix`:** only Paint and Pan run `gestures()`. The other cases assert `flags()` only.

## Acceptance criteria
1. `npx playwright test --list` lists 301 tests (the @probe tests excluded). None of the deleted tests remain, and `label-lock-seed-train.tester.spec.ts` and `nav-select.tester.spec.ts` are gone.
2. Every shrunk test keeps its named assertions, on the reduced input stated above. `label-view` 95 asserts that brush size 41 survives the open.
3. `npm run check` and `npm run e2e` pass, with no failures.
4. On the baseline machine with 12 workers: at most 2,100 test-seconds, at most 3.3 min wall, and no test over 30 s (JSON reporter).
5. Every export of `tests/e2e/{helpers,handlerMatrix,lockCombos,raceCombos,seeding}.ts` is imported by at least one remaining spec file (checked by grep). Helpers left unused are removed.
6. **Docs:** Each of these specs gets a Status line, "Amended by spec 052", naming its criterion and the new test:
   - 012 c6 (dropped);
   - 013 c1 and c5 (unit `shelf` and `label-alignment` 125);
   - 014 c9 (`label-roundtrip` plus `io/maskExport`);
   - 017 line 47 (`nav-select.tester` removed);
   - 018 c3 (one raster, 10 positions);
   - 020 c4 (rotated UTM) and c8 (cap: unit only);
   - 045 c3 (unit plus `basemap` 63);
   - 046 c6 (spec 048 c7's test).

   README and CLAUDE.md name no deleted test and need no edit. CHANGELOG gets a dated entry at merge.
