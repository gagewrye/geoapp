# 061: Prune e2e edge cases of stable features

**Status:** Accepted (2026-11-12), with the answers below. **Amendment 1 (2026-11-12, approved by Gage: "cut more")**: Tier A's PR #10 ran 35:02 over 4 shards, against 29:24–35:04 on main, so the change was lost in runner noise. Amendment 1 adds Tier B and Tier C (time-targeted cuts). **Gage approved all 99 cuts (Tiers A, B and C) on 2026-11-12**, and chose "On CI" for the per-test timings: a local full run once overloaded his laptop. So no full e2e run happens locally anywhere in this spec. A local run covers only single changed files, with `--workers=2`. **ADRs:** none. **Request** (Gage): "Are there any tests that can be removed for stable features unlikely to change?" Follows spec 052 and spec 060 c14.

## Questions, answered by Gage (2026-11-12)
1. **Tiers:** first Tier A only, then "cut more", which adds B and C.
2. **Dates:** criterion 8's `git log` check is enough.
3. **Kept:** the saved-data tests (`label-persist-lock.t`, `label-export-snapshot.t`, `label-lock-export.t`, `race-opens.t` 8, `imagery.t`) and `brush-space-focus.t`.
4. **Local-only @ci-skip tests stay:** `class-map` 44 and `fill-polygon` 32.

## Delete. .t = .tester.spec.ts; ✕ = the whole file
**Tier A (38 tests, done in PR #10).**
- Whole files: `nav-undo.t` (9), `cursor-lock.t` (2), `label-view.t` (2), `label-view-pan.t` (5), `open-progress.t` (6), `alpha.t` (1), `label-import-progress.t` (2), `label-overlay.t` (1) and `space.t` (2).
- `undo` 61 ×2 and `brush-panel` 97 (all @ci-skip); `race-opens.t` 36 and 65; `space` 50 at zoom 12; `label-quads.t` 130 ×2.
- **Lost:** see the CHANGELOG entry. The worst losses are panning and importing while a preview loads, hidden labels under locks, and dab = hover on 4326 globes.
- **Kept (criterion 8's date check):** `label-lock-export.t` 55, 75 and 99, `undo-seed.t` and `label-controls.t`, because spec 004 had a body edit on 11-02.

**Tier B (27 tests, brush edge cases; un-deferred by "cut more").** Unit cover: `map/brush.*`, `core/brush.tester`, `core/pixel`, `core/nodata`, `core/spans`.
- `brush-handler-matrix.t`: every case except Paint and Pan (9).
- `brush-contextmenu-all.t`: 31, 52, and 43's Pan and Space cases (4).
- `brush-180.t`: 68 and 83.
- Whole files: `brush-input.t` (4), `brush-edge.t` (3), `brush-nodata.t` (2), `brush-gaps.t` (1, 120 s timeout) and `brush-scope.t` (2, including @ci-skip 38).
- **Lost:** a right press mid-stroke, pinch, keyboard zoom, a blur ending a stroke, the clipped edge hover, MAX_LAT, and the 180° hover and world copy.

**Tier C (34 tests, chosen for time).**
| File: test (line) | Why slow | Still covered by | Lost, with nothing else testing it marked ⚠ |
|---|---|---|---|
| paint-latency ✕ (1) | 64 MiB 4096² file, 300 s timeout | `brush-hover` 74 (no imagery reads); unit `io/paintQueue`, `core/spans` | ⚠ spec 023 c9: one op per move, swept = per-cell, on a big file |
| label-edit ✕ (2) | 180 + 120 s | `label-roundtrip` 7 (no nodata label), `shelf` 21 (no off-origin request) | (none) |
| alpha ✕ (1) | 180 s | unit `io/alpha`, `core/alpha` | ⚠ the alpha band end to end (spec 022) |
| label-quads.t ✕ (85, 162) | 180 + 120 s | `label-alignment` 79/124; unit `labelQuads*` | ⚠ rendering of 128-quad tiles; mask quads above the mask |
| label-seams ✕ (1) | 120 s, pixel sampling | unit `labelQuads.lattice*` | ⚠ seam colour (spec 011 c6) |
| label-import-progress 106, 121, 136, 166 | 120 s each | `label-import-progress` 79/150/198; `label-mask` 132; `label-import` 40 | ⚠ open during an import; Cancel then a failed read |
| cursor-lock 64 | 120 s | `cursor-lock` 30; `label-lock-edits` 7 | the not-allowed cursor during an Export |
| label-view 95, 145, 236, 262, 274 | 5 opens | `label-view` 55/72/122/163/188/217/245 | ⚠ opacity and size kept on an open; Pan on load (016 c8) |
| label-mask 117; shelf 59; undo 76 | opens and imports | `brush-scope` 27; `label-import` 40; unit `ui/undo` | (none) |
| navigation: 47, 66, 83 "none"; 160 pointercancel and buttons 0; 182 "plus" and "none"; 266 KeyD | WASD timing; 8 opens | the kept "paint" cases; `navigation` 222–248 | ⚠ Pan-mode WASD with + focused; pointercancel ending a middle pan |
| basemap 63 zoom 3; label-alignment 124 4326; brush-hover 30 zoom 3; brush-paint 35 two moves; status-bar 68 1280x720; edges ✕ | duplicates | the other case; `globe` 19; `brush-paint` 56; `layout` 19 | (none) |

**Kept regardless:**
- the smoke list: `open-progress` 60, `brush-paint` 35, `tool-keys` 24, `fill-polygon` 74 and 129, `smart-select` 74, `label-mask` 57, `label-roundtrip` 7, `redo` 13, `brush-panel` 61 and 82, `label-persist` 39 and 76, `navigation` 47, 66 and 182;
- the saved-data tests and the 6 spec 004 tests;
- `label-persist` (all), `shelf` 21, `undo-seed`, `label-stale`, `label-replace` and `label-roundtrip`;
- everything in the areas specs 062+ (bounding box) will change: `smart-select`, `smart-model*`, `fill-polygon`, `right-click-discard.t`, `tool-strip-tidy*`, `tool-keys`, `erase-any`, `layout`, `class-map*`, `import-folder` and `save-folder*`.

**Effect, against main 4a54545 (325 listed, 319 with `CI=1`):**
- Listed tests: 325 → 226 (−99). With `CI=1`: 319 → 224 (−30%).
- Spec files: 85 → 65.
- @ci-skip tests: 6 → 2.
- Time, estimated: the Tier C rows alone carry roughly 1,100–1,600 test-seconds. Tiers A–C together should cut about 2.5–3.5 min from each 8–10 min shard, that is 25–35%, which is larger than the runner noise.

## Acceptance criteria
1. `--list` (no `CI`) lists 226 tests (N − 99, where N is 325 at 4a54545). No deleted title remains, and no ✕ file remains.
2. With `CI=1`, `--list` has no @ci-skip title. Without `CI`, `--grep @ci-skip` lists exactly `class-map` 44 and `fill-polygon` 32.
3. **Partial cuts.** Grepping `--list` shows that only these cases remain in the partly cut files:
   - `brush-handler-matrix.t`: Paint and Pan.
   - `brush-contextmenu-all.t`: 43 Paint.
   - `brush-180.t`: 46.
   - `race-opens.t`: 8.
   - `space` 50: zoom 14.
   - Every Tier C partial row keeps exactly the cases its "Still covered by" column names.
   
   `git diff main...HEAD` is empty for the files named in the last two "Kept regardless" bullets and for `label-lock-export.t`, `undo-seed.t` and `label-controls.t`.
4. `--list` contains every smoke test above. No deleted test is named by a spec numbered 062 or above on `main` at implementation time (a grep checks this; any match is held back and escalated).
5. Every export of `tests/e2e/{helpers,handlerMatrix,lockCombos,raceCombos,seeding}.ts` is still imported, and helpers left unused are removed (a grep checks this).
6. **Timed on CI, before cutting.** CI's dot logs have no per-test durations, and its HTML report uploads only on failure.
   - **A temporary commit** on the branch, made after Tier A and before any Tier B or C deletion, changes `ci.yml`:
     - The e2e step also writes Playwright's JSON report, for example `--reporter=dot,json` with `PLAYWRIGHT_JSON_OUTPUT_NAME=results-<shard>.json`. The implementer confirms on Playwright 1.64.1 that this form writes both reports. Playwright's docs show multiple reporters only in the config, so a `CI`-only config entry is the fallback.
     - An `if: always()` step uploads that JSON as `e2e-json-<shard>` from all 4 shards, whatever the outcome.
   - **The ranking.** The implementer collects the 4 JSONs and ranks every test by duration. The PR gets the 40 slowest tests and the total test-seconds.
   - **Rules:**
     - A listed Tier C test that took under 5 s on CI is kept, and criterion 1's count rises by one for each.
     - A test not listed here that is among the 15 slowest is reported to the orchestrator as a candidate, and not cut.
7. **Measured on CI, after cutting.**
   - **The target.** A second run with the same temporary commit, after the cuts, totals at most 75% of the first run's test-seconds. The first run covers the same tests plus the ones deleted.
   - **Also recorded.** The PR records its 4 shard wall times next to main's last 3 green runs.
   - **On a miss**, the orchestrator escalates to Gage with the ranking.
   - **The temporary commit is reverted before merge.** `git diff main...HEAD -- .github/workflows` is empty.
8. `npm run check` passes and `ci` is green. Each Tier B and C row passes the `git log -1 --format=%cs` check on its spec files: a row whose spec body changed after 2026-10-31 is held back and escalated. Tier A's result was that spec 004 was held back.
9. **Docs:** each spec whose criterion loses its only e2e test gets "Amended by spec 061" in its Status: 011 c6, 018 c3, 022, 023 c9 and 016 c8, plus any others a grep of `docs/specs` for the deleted names finds. The CHANGELOG entry lists every ⚠ item.
