# 030: Preview warp and mask preview from a projected lattice

**Status:** Approved under Gage's 2026-10-30 perf delegation. **ADRs:** none. This extends ADR 0023's self-checked lattice to preview sampling, with results kept exact. Written against main b86d6d8.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): unit `core/lattice.tester` (criterion 1) and `io/pipeline.yield`.

**Goal:** Opening a raster and importing labels lose their remaining long tasks, and the typical preview draws sooner, with no change to any output pixel.

## Evidence (perf/results/typical-final2, largest-final2; main b86d6d8)
- **Open, typical chunk** (6485², UTM 18N): 0.68 s to a drawn preview, with one long task of 366 ms.
  - Of 668 ms busy, about 300 ms is proj4 (`forward`, `transformInternal`, `gatg`, `clens`, `hypot`), called by `mercatorGrid`'s `each` (`core/warp.ts:44-53`) once per preview pixel, up to 1024².
- **Open, Chunk 11:** 0.45 s, with a 166 ms long task.
- **Import, typical chunk:** one long task of about 341 ms in `previewCells` (`core/maskPreview.ts:10-20`). It runs the same `each`, and it is spec 028's known follow-up.

## Scope
1. **Lattice in `mercatorGrid.each`.** This serves both `warpPreview` and `previewCells`.
   - **Exact nodes:** the source position (c, r) = `invertAffine(fromLonLat(...))` is computed exactly at lattice nodes every `PREVIEW_LATTICE` = 16 preview pixels, plus the last row and column.
   - **Interpolated pixels:** every other pixel centre's (c, r) is the bilinear interpolation of its cell's nodes.
   - **Self-check, as in ADR 0023:** each cell's centre is also computed exactly. If any interpolated centre is off by more than `PREVIEW_CHECK` = 0.001 source px, the lattice halves for the whole preview, down to step 1, which is exact.
   - **Non-finite points, following spec 029:** a cell with a non-finite node, or with a centre that isn't finite, has its pixels computed exactly.
2. **Exact near pixel edges.** After interpolation, a pixel whose c or r lies within `PREVIEW_EDGE` = 0.005 of a whole number (5x the checked error) is computed exactly.
   - So every `Math.floor(c)` and `Math.floor(r)` equals the exact one wherever the checked error bound holds, and previews, mask cells and buckets stay byte-equal.
   - About 2% of pixels need this.
   - Spec 014 criterion 1 (brute-force cells) is unchanged.
3. **Follow-up, spec 029 wording:** Scope 3's "drops the oldest first" becomes "drops the least recently used first".
4. **Follow-up, file size:** `io/maskCache.ts` is at 204 lines. `readBand`'s read planning (the plan, the cap, `rowReads`, `groupReads` and the read function) moves to a new `io/bandReads.ts`, with no behaviour change.
5. **Yield before the warp.** `buildPreview` now yields with `yieldToBrowser()` (a `MessageChannel` post) instead of `setTimeout(r, 20)`. In slow runs that timer fired 200–300 ms late and held up the open. Spec 019 never specified the 20 ms.

**Known limits:** `latticeEach` checks only nodes and cell centres, so a feature smaller than a cell can slip through: a NaN hole under 16 px, or a ripple with a 16 px period. Real proj4 grids are smooth and their NaN regions are large, and no tested real grid misses.

**Out of scope:**
- Workers.
- `mercBounds`, which makes 132 projections.
- NaN handling in spec 026's tile quads, which remains spec 029's follow-up.

## Interfaces (`core/`)
```ts
// core/lattice.ts (pure)
export const PREVIEW_LATTICE = 16, PREVIEW_CHECK = 0.001, PREVIEW_EDGE = 0.005;
export function latticeEach(width: number, height: number, exact: (u: number, v: number) => [number, number],
  f: (o: number, c: number, r: number) => void): void;   // u, v: preview pixel; visits every pixel row-major
```
`mercatorGrid` keeps its signature, and its `each` calls `latticeEach`. `io/bandReads.ts` exports the planning `readBand` uses, taking what it needs as parameters, with no import from `maskCache.ts`.

## Acceptance criteria
1. **Unit, brute force, `latticeEach` against an exact loop:** `Math.floor(c)` and `Math.floor(r)` are equal for every pixel, on these grids:
   - spec 003's EPSG:32633 grid;
   - Gage's UTM 18N 0.1 m grid;
   - EPSG:4326 at 0°, 60° and 84°;
   - a 30 m UTM grid at 63° N;
   - a grid partly outside proj4's valid area (NaN points).
2. **Unit, spy on `fromLonLat`:** for a 1024² preview of the typical chunk's grid, calls ≤ 40,000 (were 1,048,576).
3. **Unit:**
   - The existing preview fixtures give byte-equal RGBA.
   - `previewCells` and `cellBuckets` are byte-equal to the exact loop.
   - Spec 014 criterion 1 and spec 019 criterion 2 pass unchanged.
4. **Real chunks, `run.mjs`, open phase:**
   - Typical: `toPreviewDrawnMs` ≤ **450 ms** (was 680), with the longest of `longTasks` ≤ **100 ms** (was 366).
   - Chunk 11: longest task ≤ **80 ms** (was 166).
   - These targets are judged on the median of warm runs, with the cold run discarded. About 1 run in 4–8 has a 100–300 ms whole-browser idle stall that the app can't influence (a Chrome trace shows every thread idle).
5. **Real chunks, `run.mjs`, import phase, typical chunk:** the longest of `longTasks` ≤ **100 ms** (was about 341).
6. **Code:**
   - `io/maskCache.ts` is ≤ 200 lines.
   - Spec 023's and 028's mask-cache tests pass unchanged.
   - Spec 029 Scope 3 reads "least recently used".
7. `npm run check` passes.
