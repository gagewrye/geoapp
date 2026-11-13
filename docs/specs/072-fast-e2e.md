# 072: Every e2e test runs in 15 s or less on CI

**Status:** Accepted under Gage's standing rule (2026-11-12): "Keep this as a rule for testing. I want quick iterations since this is not a production system currently." **ADRs:** none. **Builds on:** spec 052 (precedent), spec 071 (its helpers `labelsIn`, `labelCount` and `overlaysIdle`, and its tests). **Lands after:** spec 071. Scope items 1 and 2 come first. The CI timeout (criterion 6) is this spec's last commit. The table runs past one page because it lists every test.

**Shrunk by spec 073 (2026-11-12; order 061 → 062 → 073 → 071 → 072).**
- **Superseded rows,** deleted by 073:
  - every `brush-*`, `label-edit` 10, `label-mask` 57, `brush-paint`, `brush-scope` 27 and `brush-slider` 22 row (R1);
  - every `*.tester` row: `label-persist-lock.t` 26, `label-lock-export.t` ×5, `undo-seed.t` 10, `label-export-snapshot.t` 24, `label-classmap-names.t` 18, `label-controls.t` 31, `brush-space-focus.t` (R2; Gage answered Q1 "delete").
- **The 17 tests left:** `label-persist` 76, 39, 104 and 123; `label-roundtrip` 7; `undo-seed` 76; `undo` 49 and 17; `label-replace` 36 and 64; `save-folder` 91; `class-map` 111; `label-import-progress` 78, 105 and 121; and `import-folder` 86.
- **Also kept, since Gage said no to their 073 P rows (2026-11-12):** `basemap` 95 (now 93) and `label-edit` 29 (now 10, its only test). That makes 19 tests, all still on main (checked 2026-11-13). Any other kept test over 15 s on current main is added at build time under the standing rule.
- **The superseded `*.tester` rows stay deleted:** Gage answered Q1 "delete".
- **Unchanged:** Step 0 and the 15 s CI timeout. Spec 072 also takes `labelsIn` and `labelCount` from 071.

**Amended after spec 071 merged (main 1f40296, 2026-11-13):**
- The 071 reviewer found two gaps in `overlaysIdle()`, so making it safe is now this spec's first scope item and criterion.
- The test table below lists only the 19 tests still on main.
- The reviewer also noted, without blocking, that `src/ui/labelDisplay.ts` is 275 lines. It isn't split here.

## Scope item 1: make `overlaysIdle()` safe to wait on (before any test relies on it)
**The reviewer's finding (071 review):** `jumpTo` (`tests/e2e/helpers.ts:85-91`) waits only for map `idle`, which leaves two gaps:
- **The settle debounce:** the 150 ms `SETTLE_MS` debounce after `moveend` (`src/ui/imagery.ts:38-42`) calls `viewSettled` → `display.settled()`. Inside that window, `idle()` resolves before the new view's overlays are planned.
- **Mask-base reads:** reads in flight (`reading`, `pending`; `src/ui/labelDisplay.ts:64-80`) call `scheduleFill()` when they finish, and `idle()` doesn't see them.

**The fix:**
- `labelDisplay`'s `idle()` also waits while `reading > 0`.
- `src/ui/imagery.ts` exposes `settling: () => debounce !== null`. The `overlaysIdle` hook in `src/ui/main.ts:131` waits until it is false, then until `idle()` resolves.
- **Until this lands,** a test that moves the map calls `settled(page)` before `overlaysIdle()`, as `class-map` 44 does.

## Scope item 2: make "waits for queued quad prefetches" deterministic
- **The failure:** the unit test at `tests/unit/ui/labelDisplay.test.ts:174`, merged in 071, failed once in a 3-file run under heavy local load (load average 10–19). It passes alone in 155 ms, and passed in 2 of 3 whole-file runs.
- **Why that matters:** it is meant to run on stubbed animation frames and faked timers, so a failure that depends on load means something still waits on real time.
- **The fix:** the implementer finds that wait and puts it under the fakes or the stubs. Candidates to check: `requestIdleCallback` or its `setTimeout` fallback in `map/quadCache.ts`, a real `setTimeout`/`queueMicrotask` chain, or `performance.now()`.
- **Not a fix:** raising a timeout.

## Step 0 result (amendment, 2026-11-13; CI runs 43491180826 and 43505857065)
Per fixture, two cases per run, in ms: building the fixture in Node, the open, `jumpTo` at zoom 7, then one stroke.
- **`rgbFixture` (Float32 1000² strip):** build 2,000–2,800, open 2,200–2,700, jump 500–650, stroke 300–800.
- **Float32 1000² in 256 px tiles:** build 60–70, open 3,000–3,900, stroke 170–240. The 12 MB upload dominates.
- **Uint8 1000² tiled:** build 50–70, open 1,300–1,750, stroke 100. **The same with GDAL_NODATA 0:** open 1,360–1,520, stroke 140.
- **512² tiled:** Float32 open 1,000–1,330, Uint8 open 420–450, strokes 110–140.

**Decision:** `rgbFixture` (and `rgbNodataFixture`, `nodataImagery`) become Uint8 in 256 px tiles with GDAL_NODATA 0, which no pixel holds. Each is built once per worker. They save about 3.5 s per open and keep the grid, every position and the mask reads (spec 023) that a Uint8 file with no nodata would skip. 512² would save about 1 s more per open but changes the grid under about 60 tests, so it isn't the default. `nodataImagery`'s nodata becomes 0. No kept e2e test needs the strip layout, so there is no `rgbStrip`.

**Also over 15 s on current main** (run 43491180826), so added under the standing rule: `layout` 50, `label-view` 71, 142 and 94, `label-lock-edits` 7, `save-folder` 82 and 72, `redo` 13, `undo-seed` 64, 44 and 54, `shelf` 18 and `label-stale` 23. The two runs differ by up to 7 s per test, so the target is about 10 s.

## Open questions
1. **Which fixture is the cheap default?** Step 0 decides by measurement (see Levers). The implementer records the result in this spec as an amendment before changing any test.
2. **Is 15 s a hard limit?** Recommended: yes, as the CI test timeout (criterion 6), so a slower test fails and CLAUDE.md's rule sends it back to be refactored. Local runs keep 60 s.

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

## Tests (19 left on main; CI seconds from run 43349765294)
Line numbers are from the working tree on 2026-11-13. The implementer rechecks them on current main. Tests that spec 073 deleted are gone from this table; "Shrunk by spec 073" above lists them.

| Test | s | Levers and what changes |
|---|---|---|
| label-persist 76 | 30.8 | F, R: compare the Export by tiles. The mask is 512² if F allows. |
| label-persist 39 | 30.0 | S: (tiles and classes) and (selection and opacity) become 2 tests, each with one Saved and one reload. F, W (`#save-state`). |
| label-persist 104, 123 | 22.8, 21.9 | F, W |
| basemap 93 (was 95) | 29.0 | S: "one request, the same in two sessions" and "moving makes none" become 2 tests. The second session stays a bare `openApp`. |
| label-roundtrip 7 | 26.5 | F, R. The byte-for-byte tile check and the class list stay. |
| undo-seed 76 | 22.2 | F, W (the paused-sink gate), R |
| undo 49, 17 | 22.1, 17.8 | F. For 49, the second open is `anotherRaster` on the cheap fixture. |
| label-replace 36, 64 | 21.2, 20.5 | S for 36 (Cancel) versus (OK). F, R. |
| save-folder 91 | 20.4 | F, W (picker stubs) |
| class-map 111 | 20.1 | S: the import, the export and the pending restore become 3 tests. |
| label-edit 10 (was 29: no network on import or export) | 17.6 (120 and 180 s timeouts in earlier runs) | F, W |
| label-import-progress 78, 105, 121 | 18.0–16.4 | F: a tiled 512² mask has 4 windows. Criterion 2's "Cancel at window k" uses k < 4. W (the gates). |
| import-folder 86 | 15.2 | F, W |

**Waiting on overlays:** any of these that waits on overlays uses `overlaysIdle()` only after scope item 1 lands, and until then calls `settled(page)` first.

**Not in this spec:** spec 071's tests.

## Acceptance criteria
1. **`overlaysIdle()` is safe (scope item 1).** Two new cases in `tests/unit/ui/labelDisplay.test.ts`:
   - `idle()` stays unresolved while a `readBase` promise is pending, and resolves once that read finishes and its fill runs.
   - The `overlaysIdle` hook stays unresolved while a settle is pending (`settling()` is true), and resolves after the settle and `idle()`.

   Both run on faked timers and stubbed frames.
2. **The prefetch test is deterministic (scope item 2).**
   - `labelDisplay.test.ts` "waits for queued quad prefetches" uses no real timer, frame, idle callback or clock. Its fakes and stubs cover all of them, and the commit names the wait it found.
   - It passes 20 times in a row with `--repeat=20`, run alongside the other 2 files of the failing run while the CPU is busy. Its timeout is unchanged.
3. **Every listed test, and every test split from one, runs in ≤ 15 s on CI** in each of 3 consecutive runs of this spec's PR, read from a CI JSON report. The rest of the suite stays under 15 s too.
4. **The criteria are kept.**
   - Each test, or the set of tests split from it, keeps every assertion of its original.
   - A split test's titles name the original criterion.
   - The reviewer checks both against the diff.
   - `--list` shows each split as its listed parts.
5. **No fixed waits** in the changed tests: no `waitForTimeout`, and no `labels(page)` (checked by grep in those files). Step 0's timings are recorded in this spec.
6. **The rule is enforced.**
   - `playwright.config.ts` sets `timeout: process.env.CI ? 15_000 : 60_000`.
   - No file in `tests/e2e/` calls `test.setTimeout` above 15,000.
   - A `tests/unit/ci.test.ts` assertion checks both.
7. **Docs:** a CHANGELOG entry, and README's Develop section notes the 15 s limit.

## Standing text for CLAUDE.md (Gage replaces lines 38–39 with this; it merges spec 071's text)
> - Every e2e test runs in 15 s or less on CI; Playwright's CI timeout enforces it. A test that times out or runs slower is a badly made test, whatever the PR changed: the implementer refactors or splits it (cheaper fixture, read only what it checks, wait on app state or events rather than time or pixels, or independent smaller tests). Never skip, tag out or retry it. Fix it in the same PR if it is one or two tests; otherwise escalate to Gage.
> - A test that fails by assertion goes back to the implementer as a normal failure.
