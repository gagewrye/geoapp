# 026: Tile quads from a projected lattice

**Status:** Approved under Gage's 2026-10-30 perf delegation. **ADR:** 0023 (amends 0019). Changes only `core/labelQuads.ts` internals plus a quad cache in `core/imagery.ts` and its caller. Spec 023's F5 precompute keeps calling `tileQuads` unchanged.

**Goal:** Placing a new imagery or label tile takes about 1 ms instead of 10–15 ms, with ADR 0019's accuracy kept.

## Evidence (perf/baseline.md §1, §3, §4)
- `tileQuads` (`core/labelQuads.ts:17-70`) projects all 258² pixel corners of a tile, about 66,000 `toLonLat` plus `mercator` calls, at 10–15 ms per tile.
- That is 0.6–0.8 s of every 42-tile mid-zoom fill: proj4 `inverse` 283 ms, `transformInternal` 191, `gatg` 89, `clens` 81, `tileQuads` 107. It contributes to long tasks of up to about 200 ms.
- It also appears in every paint and pan profile.
- Imagery tiles evicted by the LRU recompute their quads when they come back.

## Scope
1. **Lattice.**
   - `tileQuads` projects corners on a lattice every `LATTICE` = 16 px, plus the window's last corner and the extra outer ring it already uses: 18² = 324 projections for a 256² window, instead of 66,564.
   - Every other corner's Mercator position is the bilinear interpolation of its lattice cell. Lon/lat is projected exactly at lattice nodes, cell centres and quad corners, and never interpolated (spec 029).
   - A cell with only some nodes that project to finite values has every corner projected exactly; a cell with none stays non-finite and is never checked (spec 029).
2. **Self-check.**
   - It also projects each lattice cell's centre corner exactly: 256 more projections.
   - If any centre's interpolated Mercator position is off by more than `LATTICE_TOL` = 0.005 of that pixel's narrowest width, the lattice halves (16, then 8, 4, 2) for the whole tile, down to 1, which is exact.
   - The band search and its 0.05 px check are unchanged and run on the interpolated positions.
   - So the total error is ≤ 0.05 + 0.005 px between checked points. Corners beyond `MAX_LAT` are handled as today.
   - The self-check skips a centre whose projection isn't finite, and a cell whose 4 nodes aren't all finite (spec 029).
3. **Quad cache.** Imagery quads are cached by level and tile key for the raster's life (corners only, under 1 KiB per tile), so evicted tiles don't recompute them. The cache holds at most `4 × IMAGERY_TILES` (2,048) entries, at most about 2 MiB, and drops the least recently used first; a dropped tile recomputes its quads (spec 029). Label quads are already built once per tile (`map/labelOverlay.ts`).

**Out of scope:** workers; the `warpPreview` projections, which run once per open.

## Interfaces
`tileQuads(grid, w, maxErr)` keeps its signature. `core/labelQuads.ts` adds `export const LATTICE = 16, LATTICE_TOL = 0.005;`, and `core/imagery.ts`'s `imageryQuads` gains a cache keyed by `${level.s}:${key}`.

## Acceptance criteria
1. **Unit, brute force:** for these grids, every pixel corner of every returned quad is within 0.055 of its pixel's narrowest width of its true Mercator position:
   - spec 003's EPSG:32633 grid;
   - Gage's UTM 18N 0.1 m grid;
   - EPSG:4326 at 0°, 60° and 84°;
   - a 30 m UTM grid at 63° N;
   - a decimated s = 4 level of each.
2. **Unit:** on the same grids, the band count is the same as the exact algorithm's, or at most one subdivision step higher.
3. **Unit, spy on `toLonLat`:** on Gage's grid, a 256² tile makes ≤ 600 projections.
4. **Unit:** a grid curved enough to fail the self-check (EPSG:4326 near 85°, coarse pixels) halves the lattice and still meets criterion 1.
5. **Unit:** an imagery tile evicted and redrawn calls `tileQuads` once in total.
6. **Real chunks, `run.mjs`:**
   - `tileQuads` self plus proj4 time per mid-zoom fill ≤ 80 ms on Chunk 11 (was about 0.75 s). Like the baseline measure, this excludes the `fits` band check.
   - The longest task during a mid-zoom fill on Chunk 11 ≤ 100 ms (was about 200 ms).
   - On the typical and tiled chunks, this target moves to spec 028 (amended under Gage's perf delegation). Their remaining long task is a strip decode plus tile draws, not quads.
   - With specs 025 and 026 both in: mid-zoom last tile ≤ **1.3 s** typical and ≤ **1.6 s** on Chunk 11 (baseline 2.80 / 3.37 s; 025 alone 1.65 / 2.00 s). These targets moved here from spec 025.
7. Spec 018's alignment criteria, spec 020 criteria 3 and 4, and spec 022 criterion 6 pass. `npm run check` passes.
