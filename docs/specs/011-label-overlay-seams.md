# 011: Fix unpainted strips along label tile seams

**Goal:** Painted labels show without the gaps and double-darkened strips where spec 003's 256x256 label tiles meet; only rare sub-pixel hairlines may remain.

**Status:** Approved (Gage, 2026-10-27); revised 2026-10-28: the shared grid is kept and its residual hairlines are accepted, with no GPU layer for now (Gage). **ADRs:** 0016 shared overlay grid (Accepted; amends 0010). Amends spec 003's `overlayIndex` interface and Display rule.

**Open question (Gage, unanswered; doesn't block this fix).** What CRS is your imagery, and do the strips sit on the 256-pixel tile grid? Irregular bands may instead be imagery nodata, which is never labelled (spec 003).

## Defect
Each stored tile is drawn as its own canvas (`map/labelOverlay.ts`), sampled by `core/overlay.ts` `overlayIndex` on the Mercator grid that `core/warp.ts` `mercatorGrid` fits to that tile's own bounding box. An overlay pixel is opaque only if its centre falls in the tile. On grids rotated against Mercator (UTM off its central meridian), neighbouring tiles' pixel grids are offset by arbitrary fractions of a pixel. So along each shared edge some spots are painted by neither overlay (gaps up to about a raster pixel wide) and some by both (darker at `raster-opacity` 0.6). EPSG:4326 and 3857 grids align with Mercator and don't show it. The label store itself is correct.

## Scope
In: overlays of one raster sample one shared Mercator pixel grid, so tiles partition the overlay pixels.
Out: the imagery and AlphaEarth previews; the hairlines left by MapLibre rounding each image source's corners independently (`image_source.ts` `_round()`, maplibre-gl 6.16.0), accepted in ADR 0016; a custom WebGL layer.

## Interfaces (`core/`)
```ts
overlayPitch(grid: Grid): number
  // Mercator metres per overlay pixel: the longest Mercator bbox side (densified edges, as mercatorGrid) of the
  // raster's four corner tile windows, / TILE_SIZE
overlayIndex(w: Window, grid: Grid, pitch: number): { index: Int32Array; width: number; height: number; corners: [number, number][] }
  // pixel edges at integer multiples of pitch from Mercator (0, 0); covers every pitch cell whose centre maps into w;
  // per pixel: index into w's tile of the raster pixel holding its centre, or -1; corners lon/lat TL, TR, BR, BL
```
`overlayIndex(w, grid, maxSide)` and spec 003's "same Mercator grid as warpPreview" are replaced. `LabelOverlays` computes `overlayPitch` once per raster.

**Exception (ADR 0016).** On a raster crossing ±`MAX_LAT`, a middle tile row clipped at the limit can be far taller in Mercator than any corner tile, so its overlays exceed `TILE_SIZE + 2` (about 910 px measured); display stays correct. The "known gap" test pins this.

## Acceptance criteria
1. Partition (unit, regression): build overlays for a fully labelled 2x2 block of tiles on three grids: spec 003's EPSG:32633 fixture; a synthetic EPSG:32633 grid 3° from the central meridian at 60°N (10 m pixels); and a synthetic EPSG:4326 grid at 45°N. For 10,000 seeded random points inside the block's footprint and at least 2 raster pixels from its outer edge, exactly one overlay has an opaque pixel covering the point (located from its corners, width and height). On the pre-fix code the first two grids fail (some points get 0 overlays, some 2).
2. Completeness (unit, brute force on the synthetic grid): every pitch cell whose centre maps (Mercator to lon/lat, `fromLonLat`, inverse gt, floor) to a pixel of tile w is inside w's overlay, and its index is that raster pixel.
3. Spec 003 criterion 6 still holds with `overlayIndex(w, grid, overlayPitch(grid))`: a labelled pixel lands within 1 overlay pixel of its reference lon/lat; corners form a Mercator rectangle; colours and alpha as before.
4. Size (unit): on every grid in criterion 1, each overlay's width and height are at most `TILE_SIZE + 2`, and `overlayPitch` is the same for every tile of a raster (it depends only on the grid). Rasters crossing ±`MAX_LAT` are the documented exception.
5. Display (e2e, `tests/e2e/label-seams.spec.ts`, `test.fail()` removed): on the synthetic EPSG:32633 grid as a single-value GeoTIFF, basemap hidden, at the zoom where one raster pixel is about 4 screen px, after one class is painted over a 2x2-tile block, `readPixels` samples 0.25 raster px either side of both seams, every 8 screen px along them (at least 900 samples). At most 2% of samples differ from the block interior's colour by more than 2 per channel. The pre-fix design differs on about 38% (382 of 1008), the shared grid on about 1% (10 of 1008).
