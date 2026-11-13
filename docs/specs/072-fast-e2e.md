# 072: Every e2e test runs in 15 s or less on CI

**Status:** Accepted under Gage's standing rule (2026-11-12): "Keep this as a rule for testing. I want quick iterations since this is not a production system currently." **ADRs:** none. **Builds on:** spec 052 (precedent), spec 071 (its helpers `labelsIn`, `labelCount` and `overlaysIdle`, and its tests). **Lands after:** spec 071. The CI timeout (criterion 4) is this spec's last commit. The table runs past one page because it lists every test.

**Shrunk by spec 073 (2026-11-12; order 061 → 062 → 073 → 071 → 072).**
- **Superseded rows,** deleted by 073:
  - every `brush-*`, `label-edit` 10, `label-mask` 57, `brush-paint`, `brush-scope` 27 and `brush-slider` 22 row (R1);
  - every `*.tester` row: `label-persist-lock.t` 26, `label-lock-export.t` ×5, `undo-seed.t` 10, `label-export-snapshot.t` 24, `label-classmap-names.t` 18, `label-controls.t` 31, `brush-space-focus.t` (R2; Gage answered Q1 "delete").
- **The 17 tests left:** `label-persist` 76, 39, 104 and 123; `label-roundtrip` 7; `undo-seed` 76; `undo` 49 and 17; `label-replace` 36 and 64; `save-folder` 91; `class-map` 111; `label-import-progress` 78, 105 and 121; and `import-folder` 86.
- **Also kept, since Gage said no to their 073 P rows (2026-11-12):** `basemap` 95 and `label-edit` 29. That makes 19 tests. Any other kept test over 15 s on current main is added at build time under the standing rule.
- **The superseded `*.tester` rows stay deleted:** Gage answered Q1 "delete".
- **Unchanged:** Step 0 and the 15 s CI timeout. Spec 072 also takes `labelsIn` and `labelCount` from 071.

## Open questions
1. **Which fixture is the cheap default?** Step 0 decides by measurement (see Levers). The implementer records the result in this spec as an amendment before changing any test.
2. **Is 15 s a hard limit?** Recommended: yes, as the CI test timeout (criterion 4), so a slower test fails and CLAUDE.md's rule sends it back to be refactored. Local runs keep 60 s.

## Root cause shared by most of the list
- **The evidence:** in run 43347647402, two cases of the same matrix file differ only in opening `rgbFixture`. "no imagery" took 4.8 s, and "Paint after Space released" took 14.4 s. So the open costs about 10 s on CI.
- **The fixture:** `rgbFixture` is one 1000² × 3 single strip (`tiff()`). So the preview, and every full-resolution imagery tile a view loads, decode the whole 3 MB strip.
- **Who pays:** about 60 test files open it, and the tests below that open two rasters, reload or import pay it 2 or 3 times.

## Levers (each test uses one or more)
- **F: a cheap fixture.**
  - **Step 0:** on a throwaway CI run, time `openApp`, then the open, then `jumpTo` at zoom 7 for three fixtures: `rgbFixture` (strip), `rgbTiled` (the same grid in 256 px tiles), and a 512² tiled raster with the same extent. The cheapest that keeps a test's criterion becomes `rgbFixture`.
  - **Tests that need the strip layout** (spec 020's block limit, read counts) switch to a renamed `rgbStrip`.
  - **Positions:** lon/lat positions stay valid, because the extent is unchanged. Cell maths uses the fixture's own grid constant.
- **R: read only what is checked.**
  - `labels()` becomes `labelsIn` or `labelCount`.
  - Whole-store comparisons use `effectiveTiles()` bytes, or the stored keys.
  - A file is compared by its tiles, not decoded pixel by pixel.
- **W: wait on state.**
  - A wait becomes waiting on `#save-state` text, a gate's counter, the message, `overlaysIdle()`, a button's enabled state, or a map event.
  - No `waitForTimeout`, and no fixed sleep in a helper (such as `clickAt`'s 80 ms) where a state is available.
- **S: split.** A test that checks several scenarios becomes independent tests, one per scenario, each with its own page, in `describe.configure({ mode: "parallel" })`.

## Tests (run 43349765294, spec 061 branch line numbers, CI seconds)
| Test | s | Levers and what changes |
|---|---|---|
| label-persist-lock.tester 26 | 30.8 | S: "before the prompt" and "while an accepted restore loads" become 2 tests. F. |
| label-persist 76 | 30.8 | F, R: compare the Export by tiles. The mask is 512² if F allows. |
| label-persist 39 | 30.0 | S: (tiles and classes) and (selection and opacity) become 2 tests, each with one Saved and one reload. F, W (`#save-state`). |
| label-persist 104, 123 | 22.8, 21.9 | F, W |
| label-lock-export.tester 75, 35, 9, 99, 55 | 29.3–15.7 | F: a smaller store means a quicker export write. W: the save-picker and write gates. S for 9 (lock and cancel) versus (the export runs again). |
| basemap 95 | 29.0 | S: "one request, the same in two sessions" and "moving makes none" become 2 tests. The second session stays a bare `openApp`. |
| label-roundtrip 7 | 26.5 | F, R. The byte-for-byte tile check and the class list stay. |
| brush-stroke 17, 33 | 23.3, 17.6 | F, W |
| brush-pan 172 | 23.1 | S: the left drag pans, and the right drag rotates. F. |
| brush-pan 69, 102, 194, 49 | 18.3–16.0 | F, W |
| brush-hover 74 | 23.1 | F: it waits for `masksDone()` on the cheap fixture. W. |
| undo-seed 76, undo-seed.tester 10 | 22.2, 18.3 | F, W (the paused-sink gate), R |
| undo 49, 17 | 22.1, 17.8 | F. For 49, the second open is `anotherRaster` on the cheap fixture. |
| label-replace 36, 64 | 21.2, 20.5 | S for 36 (Cancel) versus (OK). F, R. |
| save-folder 91 | 20.4 | F, W (picker stubs) |
| class-map 111 | 20.1 | S: the import, the export and the pending restore become 3 tests. |
| brush-space-focus.tester 65, 105 | 20.1, 15.0 | S for 65: the first chooser, then after the chooser and the discard confirm. F. |
| label-edit 10, 29 | 19.3, 17.6 (120 and 180 s timeouts in earlier runs) | F, R: `labelsIn` over the nodata block, not `labels()`. W. |
| label-export-snapshot.tester 24 | 19.1 | F, W, R |
| label-import-progress 78, 105, 121 | 18.0–16.4 | F: a tiled 512² mask has 4 windows. Criterion 2's "Cancel at window k" uses k < 4. W (the gates). |
| label-classmap-names.tester 18, label-controls.tester 31 | 17.9, 16.7 | F, W |
| brush-paint 35 (20 moves), 80 | 17.7, 15.0 | F |
| label-mask 57 | 17.0 | F, R (`effectiveTiles` already) |
| brush-scope 27, import-folder 86, brush-slider 22 | 16.2–15.0 | F, W |

**Not in this spec:** spec 071's tests.

## Acceptance criteria
1. **Every listed test, and every test split from one, runs in ≤ 15 s on CI** in each of 3 consecutive runs of this spec's PR, read from a CI JSON report. The rest of the suite stays under 15 s too.
2. **The criteria are kept.**
   - Each test, or the set of tests split from it, keeps every assertion of its original.
   - A split test's titles name the original criterion.
   - The reviewer checks both against the diff.
   - `--list` shows each split as its listed parts.
3. **No fixed waits** in the changed tests: no `waitForTimeout`, and no `labels(page)` (checked by grep in those files). Step 0's timings are recorded in this spec.
4. **The rule is enforced.**
   - `playwright.config.ts` sets `timeout: process.env.CI ? 15_000 : 60_000`.
   - No file in `tests/e2e/` calls `test.setTimeout` above 15,000.
   - A `tests/unit/ci.test.ts` assertion checks both.
5. **Docs:** a CHANGELOG entry, and README's Develop section notes the 15 s limit.

## Standing text for CLAUDE.md (Gage replaces lines 38–39 with this; it merges spec 071's text)
> - Every e2e test runs in 15 s or less on CI; Playwright's CI timeout enforces it. A test that times out or runs slower is a badly made test, whatever the PR changed: the implementer refactors or splits it (cheaper fixture, read only what it checks, wait on app state or events rather than time or pixels, or independent smaller tests). Never skip, tag out or retry it. Fix it in the same PR if it is one or two tests; otherwise escalate to Gage.
> - A test that fails by assertion goes back to the implementer as a normal failure.
