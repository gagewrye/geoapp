# 061: Prune e2e edge cases of stable features

**Status:** Accepted (2026-11-12). Gage approved it with the answers below, as relayed by the orchestrator. **ADRs:** none (tests and docs only). **Request** (Gage): "Are there any tests that can be removed for stable features unlikely to change?" Follows spec 052 and spec 060 c14. Replaces the parked "spec 061" selective-e2e idea (see Alternative).

## Questions, answered by Gage (2026-11-12)
1. **Tiers: Tier A only.** These features' specs and code areas are unchanged since 2026-10-31. Tier B is deferred (see Deferred).
2. **Dates:** I took them from CHANGELOG and spec Status lines. Criterion 7's `git log` check by the implementer is enough.
3. **Saved-data edge cases stay:** `label-persist-lock.t`, `label-export-snapshot.t`, `label-lock-export.t` (all of it, see Kept), `race-opens.t` 8 and `imagery.t`. `brush-space-focus.t` stays too.
4. **The @ci-skip tests in recent features stay local-only:** `class-map` 44 (spec 047/051) and `fill-polygon` 32 (054/059).

## Delete (38 tests; .t = .tester.spec.ts; ✕ = the whole file)
| File: test (line) | Still covered by | Coverage lost |
|---|---|---|
| nav-undo.t ✕ (9; spec 009/010, 10-28) | `navigation` 222/229/235/248, 95, 115; unit `core/wasd*`, `map/cursor` 21, `core/undo.tester` 21; `cursor-lock` 30 | speed cap under key repeat; focus and visibility stops; a middle drag from the panel; Ctrl+Z mid-stroke |
| cursor-lock.t ✕ (2) | `cursor-lock` 30, 64; `undo` 150 | a class key during a lock; Space at lock end |
| undo 61 ×2 @ci-skip, brush-panel 97 @ci-skip | `redo` 13, `undo` 91, unit `ui/undo`, `io/undoHistory`; `label-mask` 168 | local-only: overlays following each undo; overlay recolour |
| label-view.t ✕ (2), label-view-pan.t ✕ (5) (016/034, 10-29/30) | `label-view` 122/145/163/188/217/245; `cursor-lock` 64 | hidden labels × import/export locks; size change mid-stroke |
| open-progress.t ✕ (6), race-opens.t 36, 65 (019/029) | `open-progress` 60–151; `imagery` 84; `raster-race` 16, 34; `race-opens.t` 8 | navigation and import while the preview loads; out-of-order held opens |
| alpha.t ✕ (1) (022) | `alpha` 19; unit `io/alpha`, `core/alpha` | the transparency render |
| label-import-progress.t ✕ (2), label-overlay.t ✕ (1) (014/021) | `label-import-progress` 79/121/198; `label-mask` 132, 168 | the next import not pre-cancelled; restored labels taking settings changed mid-import |
| space.t ✕ (2), space 50 zoom 12 (015) | `space` 38; `space` 50 zoom 14 | contrast over the stars; a pitched horizon |
| label-quads.t 130 ×2 (018/026) | `label-alignment` 79 (UTM); `label-quads.t` 85, 162 | dab = hover on the globe on EPSG:4326, which spec 052 relied on |

**Kept (criterion 7, Gage 2026-11-12):** spec 004 had a body edit on 2026-11-02, so these 6 proposed deletions are held back and stay unchanged: `label-lock-export.t` 55, 75 and 99, `undo-seed.t` (1 test) and `label-controls.t` (2 tests).

**Smoke kept, one per feature:** open `open-progress` 60; paint `brush-paint` 35; erase `tool-keys` 24; fill and polygon `fill-polygon` 74, 129; smart select (fake model) `smart-select` 74; import `label-mask` 57; export `label-roundtrip` 7; undo/redo `redo` 13; class edits `brush-panel` 61, 82; restore `label-persist` 39, 76; navigation `navigation` 47, 66, 182.

**Effect** (counts measured against main 4a54545):
- `--list`: 325 → 287 tests, and 85 → 76 spec files.
- With `CI=1`: 319 → 284.
- @ci-skip tests: 6 → 3.
- Time, estimated: about 12 s per test on SwiftShader, with 2 workers and 4 shards, saves just under 1 min per shard and about 3–4 runner-minutes per run.

## Deferred: Tier B (27 tests), until after the bounding-box UI overhaul (specs 062+)
The brush specs are stable, but `map/brush.ts` changed on 11-02 (spec 049) and 11-12 (specs 054 and 058), and specs 062+ will change it again. Tier B covers:
- `brush-handler-matrix.t`: all cases except Paint and Pan.
- `brush-contextmenu-all.t`: 31, 52, and the Pan and Space-held cases of 43.
- `brush-180.t` 68 and 83.
- Whole files: `brush-input.t`, `brush-edge.t`, `brush-nodata.t`, `brush-gaps.t`, and `brush-scope.t` (including its @ci-skip 38).

These are revisited in a later spec once 062+ merges. This spec doesn't touch them.

## Alternative: selective e2e by changed area (the parked idea)
`--only-changed` follows the import graph of test files, and e2e files import almost nothing from `src/ui` or `src/map`, so a source change selects no e2e tests. Selective e2e needs a hand-kept map from `src/` paths to e2e files, the full suite whenever a shared file changes, the full suite on push to main, and an ADR. **Recommendation:** prune first. Revisit selective e2e only if CI is still over about 6 min per shard.

## Acceptance criteria
1. The implementer records `npx playwright test --list` (no `CI`) at 4a54545 as N. After the change it lists N − 38 tests (325 → 287), and none of the deleted titles remain. The 9 ✕ files are gone: `nav-undo`, `cursor-lock`, `label-view`, `label-view-pan`, `open-progress`, `alpha`, `label-import-progress`, `label-overlay` and `space` (each `.tester.spec.ts`).
2. With `CI=1`, `--list` includes no @ci-skip title. `--list --grep @ci-skip` (no `CI`) lists exactly `class-map` 44, `fill-polygon` 32 and `brush-scope.t` 38.
3. A `--list` grep checks the files cut but not removed:
   - `race-opens.t` keeps only 8.
   - `label-quads.t` keeps only 85 and 162.
   - `space` 50 runs only at zoom 14.
   - **No Tier B or Kept file is changed.** `git diff main...HEAD --` on these 11 files in `tests/e2e/` is empty:
     - the 8 Tier B files: `brush-handler-matrix`, `brush-contextmenu-all`, `brush-180`, `brush-input`, `brush-edge`, `brush-nodata`, `brush-gaps` and `brush-scope` (each `.tester.spec.ts`);
     - the 3 Kept files: `label-lock-export`, `undo-seed` and `label-controls` (each `.tester.spec.ts`).
     
     `brush-panel.spec.ts` isn't in the list, because this spec trims it.
4. A `--list` grep finds every smoke test named above.
5. Every export of `tests/e2e/{helpers,handlerMatrix,lockCombos,raceCombos,seeding}.ts` is imported by a remaining spec file, and helpers left unused are removed. A grep checks this.
6. `npm run check` passes, and the PR's `ci` check is green. The PR description records the 4 e2e shard durations next to main's last green run. If the total drop is under 5%, the orchestrator escalates to Gage rather than cutting more.
7. The implementer reports `git log -1 --format=%cs` for each row's spec files. Any row whose spec changed after 2026-10-31, other than Status lines, is held back and escalated. *Result:* spec 004 had a body edit on 2026-11-02, so the 6 tests under Kept are held back, by Gage's decision on 2026-11-12.
8. **Docs:** each spec whose criterion names a deleted test gets the Status line "Amended by spec 061" with its remaining coverage. They include spec 018 c3 (UTM only). A grep of `docs/specs` for each deleted file name checks this. The CHANGELOG gets a dated entry listing the "Coverage lost" column.
