# 029: Review follow-ups for specs 026 and 027, and flaky tests

**Status:** Approved under Gage's 2026-10-30 perf delegation. **ADRs:** none. Written against main with specs 021–023 and 025–027.

**Goal:** Close the non-blocking review findings, and make `npm run check` and the e2e suite reliable.

**Out of scope:** the spec 022 question of an alpha band combined with nodata 255, which is Gage's to decide.

## Scope
1. **Non-finite lattice points** (`core/labelQuads.ts:86-90`).
   - The problem:
     - The `|exLat| > MAX_LAT` skip is false for NaN, so a centre whose exact projection is NaN fails the self-check. The lattice then halves down to step 1, which is 66,564 projections per tile, for example a UTM grid far outside its zone.
     - A NaN node also spreads NaN into the interpolated positions of its cells.
   - The fix:
     - The self-check skips any centre whose projection isn't finite.
     - It also skips any cell whose 4 nodes aren't all finite.
     - Corners in such cells are projected exactly, as corners beyond `MAX_LAT` are now.
2. **Spec 026 wording, Scope 1.** Only Mercator positions are interpolated. Lon/lat is projected exactly at lattice nodes, cell centres and quad corners. The spec text changes to say so.
3. **Bounded imagery quad cache** (`map/imagery.ts:17`).
   - The cache holds at most `4 × IMAGERY_TILES` (2,048) entries and drops the oldest first, at under 1 KiB each (≤ 2 MiB).
   - It is unbounded today: about 10k entries, 5–15 MiB, after panning all of a 22,300² file.
   - A dropped entry is recomputed (about 1 ms, spec 026).
   - The text of spec 026 Scope 3 changes to match.
4. **No tile update on open while panning** (`ui/imagery.ts:66-74`). `open()` calls `update()` only when `!nav.moving()`. Otherwise the settle update (spec 027) loads the tiles.
5. **Reliable tests.**
   - `labelQuads.lattice.tester.test.ts`, "Gage's grid: every tile of a 1000 x 700 raster…" (about 5.6 s under load): still checks every tile (all 12 are corner or edge tiles), but projects each corner once and makes one `expect` per quad.
     - It must run in ≤ 1.5 s alone.
   - `pipeline.preview.test.ts`, "leaves the previews of files without overviews unchanged": uses fixtures or sizes that run in ≤ 1.5 s alone. Its comparison stays byte-equal.
   - `label-alignment.spec.ts:72` (spec 018 criterion 3) reads pixels only after the hover source has no features and one further frame has rendered, since the outline stays drawn about 2 frames after the pointer leaves for the panel.
   - No test may raise its timeout to pass. Each must fit the default 5 s under full parallel load.

## Acceptance criteria
1. **Unit:** a grid whose lattice centres project to NaN, for example EPSG:32618 at 150° E:
   - `tileQuads` makes ≤ 600 projections per 256² tile;
   - the result has no NaN corner where the exact algorithm has a finite one;
   - every finite corner meets spec 026 criterion 1's error bound.
2. **Unit:** spec 026 criteria 1–4 still pass.
3. **Unit, imagery quad cache:**
   - After 3,000 distinct tiles, exactly 2,048 entries remain, and they are the most recent.
   - A re-requested dropped tile calls `tileQuads` once.
4. **Unit, fake navigation:**
   - An open that resolves while a pan key is held starts no read until the settle.
   - Then exactly one `update` runs.
5. **Reliability:**
   - The three fixed tests each pass with `--repeat-each=5`, run on their own under a normal run's parallel load (default workers).
   - Each also meets its time limit when run alone.
   - `npm run check` passes once.
6. Spec 026 Scopes 1 and 3 are updated in the same change, as the doc rules require. `npm run check` passes.
