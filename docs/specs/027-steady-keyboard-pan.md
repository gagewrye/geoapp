# 027: Keyboard panning without reads

**Status:** Approved under Gage's 2026-10-30 perf delegation. Criterion 3's 1 s bound is no longer tested end to end (spec 060 c14, 2026-11-12): it measured the machine. **ADRs:** none. **Builds on spec 023:** it amends 023's F3, so background mask reads also wait while the map moves. It touches `map/navigation.ts`, `ui/imagery.ts` and `io/maskCache.ts`'s start condition.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `steady-pan` (criterion 3); unit `ui/steadyPan.tester`. `ui/steadyPan.test.ts` stays; no e2e test of it is left.

**Goal:** Holding W, A, S or D pans as smoothly as a mouse drag; tiles load once the pan stops.

## Evidence (perf/baseline.md §4)
- A drag fires `moveend` once, at release. WASD calls `panBy(..., { animate: false })` every frame (`map/navigation.ts:57`), and each call fires `moveend` → `update` (`ui/imagery.ts:25`), which re-plans tiles and starts strip reads and decodes mid-pan.
- On Chunk 11, holding D for 2 s gives a p95 frame of 53 ms, a max of 70 ms and 11 frames over 50 ms: 70 fps, against 187 fps for a drag. 605 MB is read.
- On the typical chunk, 12 frames are over 33 ms.
- Spec 023's background mask reads start whenever the imagery loader is idle, so without this spec they would also run during a pan.

## Scope
1. `createNavigation` exposes `moving(): boolean` (true while any pan key is held) and an `onSettle(cb)` event, fired once 150 ms after the last pan key is released.
2. `ui/imagery.ts` ignores `moveend` while `moving()`, and calls `update` once on settle.
   - Any other burst of `moveend` (a wheel zoom, `fitBounds`) is debounced by 150 ms, measured from the last event.
   - Reads already in flight finish, and queued reads no longer visible are aborted as spec 020 says.
3. Background mask reads (spec 023 F3) also wait while the map moves: during a drag, while `moving()`, and until 150 ms after the last `move` event.
   - Stroke and hover mask reads are unaffected.

**Out of scope:** loading tiles ahead in the direction of the pan.

## Interfaces
`createNavigation(...)` returns `{ …, moving(): boolean, onSettle(cb: () => void): () => void }`. In `ui/imagery.ts` and `io/maskCache.ts` this is wiring only, with no `core/` change.

## Acceptance criteria
1. **Unit, fake timers:**
   - While a pan key is held, `moveend` events start no `update`.
   - One `update` runs 150 ms after the last release.
   - Five wheel `moveend` events 20 ms apart cause one `update`.
2. **Unit, fake loader:**
   - Background mask reads don't start while the map moves, or until 150 ms after it stops.
   - Stroke-priority reads still start.
3. **E2E:** after a 1 s held D at full resolution, the visible tiles are drawn within 1 s of release.
4. **Real chunks, `run.mjs`, hold D for 2 s:**
   - Chunk 11: p95 frame ≤ 8 ms and max ≤ 20 ms (were 53 and 70 ms), with 0 imagery reads during the hold.
   - Typical: no frames over 33 ms (was 12).
5. Spec 009's WASD criteria and spec 020 criteria 7 and 8 pass. `npm run check` passes.
