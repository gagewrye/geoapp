# 071: The @ci-skip tests are refactored to run on CI, and @ci-skip is removed

**Status:** Accepted (Gage, 2026-11-12: "The timeouts should be considered poorly made tests and should be refactored"). **ADRs:** none (no dependency, no architecture change). **Builds on:** spec 060 (criteria 15 and 16 are superseded), spec 052 (read only what is checked). **Lands after:** spec 061 (PR #10).
**Amended (Gage, 2026-11-12):** "Add those two. Either make the tests more efficient or divide them into components to reduce individual test times." It adds the two slowest tests that spec 061's CI timing (run 43347647402) leaves in the suite: `label-alignment` 79 (40.5 s) and the Paint case of `brush-handler-matrix.tester` (34.0 s).
**Standing rule (Gage, 2026-11-12):** "Keep this as a rule for testing. I want quick iterations since this is not a production system currently." Every e2e test runs in 15 s or less on CI.
- Spec 071 covers the @ci-skip tests, the two named above, and all of `fill-polygon`.
- Spec 072 covers every other test over 15 s, and the CI timeout that enforces the rule.

## Questions, answered (2026-11-12)
1. **Which tests are still tagged after spec 061?** Spec 061's Tier A (PR #10) deletes both variants of `undo` 61 and `brush-panel` 97. Its Tier B deletes `brush-scope.tester.spec.ts` entirely. So spec 071 covers `class-map` 44 and `fill-polygon` 32, plus `fill-polygon` 74 and 101 as a preventive fix. The other rows below are fallbacks, used only if a test is still present, for example because spec 061 criterion 8's date check holds it back.
2. **Where does a future CI timeout get fixed?** In the same PR when the fix is to one or two tests; otherwise escalate to Gage (the recommendation, taken).

**Built after spec 061 merges.**

**Shrunk by spec 073 (2026-11-12; order 061 → 062 → 073 → 071 → 072).**
- **Deleted by 073, so their rows here are superseded:**
  - all of `fill-polygon` (32, 74, 99, 112 and the Polygon tests), `label-alignment` 79, and `brush-handler-matrix.tester` (mask labelling, R1);
  - `brush-scope.tester` 38 (a tester file, R2);
  - the `undo` 61 and `brush-panel` 97 fallbacks (spec 061).
- **What 071 still does:**
  - **`class-map` 44:** its refactor and its `overlaysIdle()` hook. Criterion 5 then needs only that hook.
  - **Removing `@ci-skip`** (criterion 1).
  - **The CLAUDE.md text.**
  - **Criterion 6** (3 green CI runs).
- **`labelsIn` and `labelCount` move to spec 072,** which uses them if any kept test reads the whole store.
- **Criteria 4 and 7 lapse.**

## Root causes
| Test | Why it is slow on CI (software GL, 2 vCPU per worker) |
|---|---|
| fill-polygon 32 (spec 054 c10) | It calls `labels()` 3 times (lines 44, 58 and 61) on a store seeded from the 1000² mask. Each call sends about 750k labelled pixels × 3 numbers over CDP and builds a 750k-entry Map in Node. This is the cost spec 052 cut elsewhere. It then makes 3,600 separate `expect`s. On CI it timed out on the last `labels()` call, after Fill, Undo and Redo had all worked. |
| class-map 44 (spec 047 c7) | It polls a rendered pixel through `readPixels`, and each try waits for a MapLibre `render`. Its `under` colour is read at zoom 8 before the full-resolution imagery tiles have loaded. On a slow runner they load later, so the colour under the mask changes and the blend it expects can drift for the whole 5 s poll. |
| undo 61, if kept (spec 010 c3) | `overlaysMatch` reads every pixel of every quad canvas in JS on each poll. The overlays it waits for are rebuilt on animation frames and idle callbacks (`map/quadCache.ts`), so a slow runner gets only a few full scans in 5 s. |
| brush-panel 97, if kept | The same canvas poll, through `overlayPixel`, waiting on the same redraw. |
| brush-scope.tester 38, if kept | A fixed `waitForTimeout(1000)` before it installs its read gate, then an instant `reads === 1` check. Under load the mask read hasn't started yet (it got 0). |
| fill-polygon 74, 99 (spec 059 c6, c7; 48.0 and 19.8 s in run 43349765294) | The same 1000² mask import, then `labels()`: 74 calls it 3 times and checks 2,304 cells one by one with `expect`; 99 calls it once to read 3 cells. |
| fill-polygon 112 (spec 054 c11; 22.0 s) | Fill labels about 997k pixels of `nodataImagery`, then `labels()` sends all of them 3 times, and a Node loop checks every key against the nodata block. |
| label-alignment 79 (spec 018 c3; 40.5 s; now the only e2e check that a dab matches its hover outline) | It runs 20 dabs (10 positions × sizes 1 and 7) in one test, about 2 s each. For each dab it does a `jumpTo`, which waits for map `idle`, and 3 clicks on the size buttons, each followed by a `textContent` read. Then `clickAt`'s fixed 80 ms, `settled`, a poll until the hover is gone, 2 frames, and a WebGL readback that waits for a `render`. Only splitting the work can bring it under target. |
| brush-handler-matrix.tester, Paint (34.0 s) | Its own flags-only cases in the same run took 14.4 s, so about 10 s of that is opening `rgbFixture` (1000², 3 bands, preview build and background mask reads). The 3 gestures (a double-click, a Shift-drag, a right drag) all paint or erase in Paint mode, and each queues mask reads and overlay redraws. `reset()` runs 4 times, and each `jumpTo` waits for `idle`, including the full-resolution imagery tiles at zoom 7. There are also fixed waits of 400 + 400 + 200 ms, and `still()` after each gesture. The Pan case (26.8 s) has the same open, resets and waits. |

## Scope
- **The refactors:**
  - Each test waits on app state or events instead of fixed time or polled pixels.
  - Each reads only the cells or one pixel that its criterion names.
  - Every `labels(page)` in `fill-polygon.spec.ts` is replaced (tests 32, 74, 99, 112 and the Polygon tests), because each has the same full-mask cost.
  - If a `fill-polygon` test is still over 15 s with `labelsIn`, its `maskFile` (and for 112, `nodataImagery`) shrinks to 512². Every block, speck and nodata window keeps its cell position. The expected `MESSAGES.filled(n)` counts are recomputed from the new size.
- **One test hook:** `__geoapp.overlaysIdle(): Promise<void>`, wired in `ui/`. It resolves once no label-overlay redraw is scheduled and `QuadCache`'s queue is empty.
- **Two helpers in `tests/e2e/helpers.ts`:**
  - `labelsIn(page, { x0, y0, width, height }): Promise<Uint8Array>` returns the effective labels in that window, row-major, read in the page through `tile(key)`.
  - `labelCount(page): Promise<number>` returns the number of non-zero effective labels, counted in the page.
- **Removing `@ci-skip`:** from titles, from `playwright.config.ts`'s `grepInvert`, from its assertion in `tests/unit/ci.test.ts`, and from README line 42.

- **The amendment's two files:** `label-alignment.spec.ts` (test 79) and `brush-handler-matrix.tester.spec.ts` (with `handlerMatrix.ts`).

**Out of scope:** changing what any test asserts, other e2e files, app behaviour, and retries (they stay at 0).

## Refactor per test
- **fill-polygon 32:**
  - Every `labels()` becomes `labelsIn` on the 60 × 60 window 380..439, or on a 1 × 1 window for the spot checks.
  - The window is compared with one `toEqual` against the expected array, built from `maskValue` and the 16 × 16 block.
  - Each step waits on its message (`MESSAGES.filled(256)`, `fillSame`) or on `#undo`/`#redo` being disabled or enabled, never on time.
- **fill-polygon 74 and 99:** `labelsIn` on the 48 × 48 window 384..431 (74) and three 1 × 1 reads (99). Test 74 compares its window with one `toEqual` per `check`.
- **fill-polygon 112:**
  - `got.size` becomes `labelCount`.
  - The nodata check becomes `labelsIn` on the 60 × 50 nodata window, all 0, plus `labelCount` equal to `1000 × 1000 − 60 × 50`. Together these are what the original key loop proved.
  - After Undo and after the nodata click, `labelCount` must be 0.
- **class-map 44:**
  - `hideImagery` and `hideBasemap` run before `under` is read, so the ground is one flat colour, as in `no-tile-limit`.
  - After the apply message, the test awaits `overlaysIdle()` and then one MapLibre `idle`, and reads the pixel once with no poll. The blend at 0.6 is still asserted.
  - The two `jumpTo`s stay.
- **undo 61:** after each undo, the test awaits `overlaysIdle()` and then runs `overlaysMatch` once, not in a poll.
- **brush-panel 97:** same as undo 61: await `overlaysIdle()`, then read `overlayPixel` once.
- **brush-scope.tester 38:**
  - `waitForTimeout(1000)` becomes waiting for map `idle` with no imagery read in flight.
  - The instant check becomes `expect.poll(reads).toBe(1)`, then a check that it is still 1 after the next map `idle`.
- **label-alignment 79: split into 4 independent tests.** The groups are size 1 at positions 0–4, size 1 at 5–9, size 7 at 0–4, and size 7 at 5–9. The file gets `test.describe.configure({ mode: "parallel" })`, so workers can schedule the tests separately.
  - Each test sets its size once, through `#brush-size-range`, instead of clicking the buttons.
  - Each test opens its own page, so no dab of one size lies under another's samples.
  - Each test asserts what the original asserts, over its 5 dabs: `inside > 0`, `outside > 0`, and no wrong sample.
  - Together, the 4 tests cover the same 10 positions × 2 sizes.
  - Unchanged: the fixture, `deviceScaleFactor: 1.25`, the zoom, the hover-gone wait and the one readback per dab. The criterion is about rendered alignment, so pixels stay.
  - `clickAt`'s 80 ms wait becomes waiting for the store to hold the dab's tile (`tileKeysStored`), then `settled`.
- **brush-handler-matrix.tester: split into 6 tests,** one per (Paint or Pan) × (double-click, Shift-drag, right drag), in the file's existing parallel mode.
  - Each test asserts `flags()` before and after its one gesture, and that gesture's result: no zoom or rotate in Paint, and a zoom or rotate in Pan. The originals' 3 outcomes × 2 modes, and their flags before and after, are all still checked.
  - **Fixture:** `rgbFixture` is replaced by a 256² single-band uint8 tiff (one tile, no nodata, so no mask reads: spec 023 F2) around `CENTRE`, covering the gesture point [15.005, 45.005]. The test is about MapLibre's handler gating, not the imagery.
  - **No resets:** each test starts at `CENTRE`, zoom 7, so `reset()` goes.
  - **Waits:** the fixed waits and `still()` are replaced by events. Before the gesture, the page records whether `zoomstart` or `rotatestart` fires. After the mouse-up, the test waits for `moveend` if one did, and for 2 animation frames if none did.
  - The result is read from those events, plus the zoom or bearing change as before.

**Targets:** each new or refactored test takes under 15 s on CI, in each of criterion 6's 3 runs.

## Acceptance criteria
1. **No tags left.** No file in `tests/` or `playwright.config.ts` contains `@ci-skip` (checked by grep). A `tests/unit/ci.test.ts` assertion replaces the old one: no e2e test title contains `@ci-skip`, and `playwright.config.ts` sets no `grepInvert` (it is removed, or `undefined`). Spec 073 removed @probe, so nothing is left to exclude.
2. **Criteria still fully covered.** Each refactored test keeps every assertion of its criterion: spec 054 c10 (one block recoloured, an unlabelled block fills, a same-class click changes nothing, Undo and Redo); spec 047 c7 (the list, the 0.6 blend in #0000ff, the painted tile byte-equal, Undo); and the rest unchanged. A reviewer checks this against the diff.
3. **No fixed waits or full scans.** The refactored tests contain no `waitForTimeout`, no `labels(page)` and no `expect.poll` around `pixelAt` or a canvas scan (checked by grep within those tests).
4. **`labelsIn`** equals the matching entries of `labels()` on a small store, a unit-sized e2e check in `fill-polygon`. Off-raster cells read as 0.
5. **`overlaysIdle`** resolves only after a stroke's overlays exist. An e2e check awaits it right after a stroke, then finds that the `label-` layer keys equal the stored tile keys, with no poll. It resolves at once when nothing is pending.
6. **Stable on CI.** On this spec's PR, the `ci` check passes on 3 consecutive runs (the first plus `gh run rerun` twice), and no refactored test times out. Locally, `npx playwright test <files> --repeat-each=3` passes under CPU throttling rate 4 (CDP `Emulation.setCPUThrottlingRate`, as spec 060 c12).
7. **The split tests (amendment).**
   - **`label-alignment`:** `--list` shows 4 criterion 3 tests whose positions × sizes together are the original 10 × 2.
   - **`brush-handler-matrix.tester`:** `--list` shows 6 tests, with every (mode, gesture) pair once.
   - **No test over 15 s:** none of these tests, nor the `class-map` and `fill-polygon` ones, takes over 15 s in the CI JSON report of any of criterion 6's 3 runs.
   - **Unchanged:** spec 018 c3's assertions (inside = colour blended at 0.6, outside = background, both sampled) and the matrix's flags and gesture outcomes, as a reviewer checks against the diff.
8. **Docs.**
   - **CHANGELOG:** the older entries' "@ci-skip: not run on CI…" notes read "@ci-skip until spec 071, which refactored it; it runs on CI again". A new dated entry is added.
   - **Spec 060's Status** gets "Criteria 15 and 16 superseded by spec 071".
   - **README line 42** drops its `@ci-skip` clause.
   - **CLAUDE.md lines 38-39** are replaced by Gage. Spec 072 gives the merged text, which adds the 15 s rule and supersedes this one. If 072 isn't merged yet, the text is:

> - An e2e test that times out on CI is a badly made test, whatever the PR changed: it goes back to the implementer to refactor (wait on app state or events, not fixed time or rendered pixels; read only what it checks; smaller fixtures). Never skip, tag out or retry it. Fix it in the same PR if it is one or two tests; otherwise escalate to Gage.
> - A test that fails by assertion goes back to the implementer as a normal failure.
