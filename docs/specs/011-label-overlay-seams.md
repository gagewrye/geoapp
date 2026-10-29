# 011: Fix unpainted strips along label tile seams

**Goal:** Painted labels show without the gaps and double-darkened strips where spec 003's 256x256 label tiles meet; only rare sub-pixel hairlines may remain.

**Status:** Approved (Gage, 2026-10-27); revised 2026-10-28: the shared grid is kept and its residual hairlines are accepted, with no GPU layer for now; the pitch rule is fixed rather than given exceptions (Gage). **ADRs:** 0016 shared overlay grid (Accepted; amends 0010). Amends spec 003's `overlayIndex` interface and Display rule.

**Open question (Gage, unanswered; doesn't block this fix).** What CRS is your imagery, and do the strips sit on the 256-pixel tile grid? Irregular bands may instead be imagery nodata, which is never labelled (spec 003).

## Defect
Each stored tile is drawn as its own canvas (`map/labelOverlay.ts`), sampled by `core/overlay.ts` `overlayIndex` on the Mercator grid that `core/warp.ts` `mercatorGrid` fits to that tile's own bounding box. An overlay pixel is opaque only if its centre falls in the tile. On grids rotated against Mercator (UTM off its central meridian), neighbouring tiles' pixel grids are offset by arbitrary fractions of a pixel. So along each shared edge some spots are painted by neither overlay (gaps up to about a raster pixel wide) and some by both (darker at `raster-opacity` 0.6). EPSG:4326 and 3857 grids align with Mercator and don't show it. The label store itself is correct.

## Scope
In: overlays of one raster sample one shared Mercator pixel grid, so tiles partition the overlay pixels.
Out: the imagery and AlphaEarth previews; the hairlines left by MapLibre rounding each image source's corners independently (`image_source.ts` `_round()`, maplibre-gl 6.16.0), accepted in ADR 0016; a custom WebGL layer.

## Interfaces (`core/`)
```ts
overlayPitch(grid: Grid): number
  // Mercator metres per overlay pixel: the longest side, over every tileWindows() window of the raster, of the
  // Mercator bbox overlayIndex itself uses (densified edges, latitude clamped to ±MAX_LAT, as mercatorGrid), / TILE_SIZE
overlayIndex(w: Window, grid: Grid, pitch: number): { index: Int32Array; width: number; height: number; corners: [number, number][] }
  // pixel edges at integer multiples of pitch from Mercator (0, 0); covers every pitch cell whose centre maps into w;
  // per pixel: index into w's tile of the raster pixel holding its centre, or -1; corners lon/lat TL, TR, BR, BL
```
`overlayIndex(w, grid, maxSide)` and spec 003's "same Mercator grid as warpPreview" are replaced. `LabelOverlays` computes `overlayPitch` once per raster.

**Pitch rule (ADR 0016, fixed 2026-10-28).** Because the pitch is the maximum over every tile, using the bbox each overlay is built from, no tile's bbox spans more than `TILE_SIZE` pitch cells. Each overlay is therefore at most `TILE_SIZE + 2` px a side on every raster, with no exceptions. That includes rasters crossing ±`MAX_LAT`, where the row clipped at the limit sets the pitch. `overlayPitch` runs once when the raster opens, at one bbox per tile window; neighbours may share edge samples, provided the result equals the per-window maximum. The old corner-tile rule is gone. The tester's `it.fails` (`tests/unit/core/overlaySeams.tester.test.ts`) becomes a passing `it`, and the "known gap" test is deleted.

## Acceptance criteria
1. Partition (unit, regression): build overlays for a fully labelled 2x2 block of tiles on three grids: spec 003's EPSG:32633 fixture; a synthetic EPSG:32633 grid 3° from the central meridian at 60°N (10 m pixels); and a synthetic EPSG:4326 grid at 45°N. For 10,000 seeded random points inside the block's footprint and at least 2 raster pixels from its outer edge, exactly one overlay has an opaque pixel covering the point (located from its corners, width and height). On the pre-fix code the first two grids fail (some points get 0 overlays, some 2).
2. Completeness (unit, brute force on the synthetic grid): every pitch cell whose centre maps (Mercator to lon/lat, `fromLonLat`, inverse gt, floor) to a pixel of tile w is inside w's overlay, and its index is that raster pixel.
3. Spec 003 criterion 6 still holds with `overlayIndex(w, grid, overlayPitch(grid))`: a labelled pixel lands within 1 overlay pixel of its reference lon/lat; corners form a Mercator rectangle; colours and alpha as before.
4. Size (unit): for every tile window of each of these grids, the overlay's width and height are at most `TILE_SIZE + 2`:
   - the grids of criterion 1;
   - the tester's `{ epsg: 4326, gt: [10, 0.01, 0, -45, 0, -0.01], width: 300, height: 520 }`, whose full middle row was 270 px under the old rule;
   - an EPSG:4326 grid of 0.01° pixels, 600x600, from 87°N down, which crosses `MAX_LAT` inside its first tile row: the kind of grid that gave about 910 px under the old rule.

   `overlayPitch` equals, to within 1e-9 relative, the brute-force maximum over all tile windows of their bbox's longest side / `TILE_SIZE`. It depends only on the grid.
5. Display (e2e, `tests/e2e/label-seams.spec.ts`, `test.fail()` removed): on the synthetic EPSG:32633 grid as a single-value GeoTIFF, basemap hidden, at the zoom where one raster pixel is about 4 screen px, after one class is painted over a 2x2-tile block, `readPixels` samples 0.25 raster px either side of both seams, every 8 screen px along them (at least 900 samples). At most 2% of samples differ from the block interior's colour by more than 2 per channel. The pre-fix design differs on about 38% (382 of 1008), the shared grid on about 1% (10 of 1008).
