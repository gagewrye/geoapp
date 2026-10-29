# 011: Fix unpainted strips along label tile seams

**Goal:** Painted labels show at full raster precision, without the gaps and double-darkened strips where spec 003's 256x256 label tiles meet; only rare sub-pixel hairlines, and overlap where pixel size steps, may remain.

**Status:** Approved (Gage, 2026-10-27); revised 2026-10-28: the shared grid is kept with its residual hairlines and no GPU layer, and the pitch follows the finest pixel, accepting seam overlap, larger canvases and a slower open (Gage: "we need labelling precision, even if there is overlap. slow opening is fine"; "your recommendations are good"). **ADRs:** 0016 shared overlay grid (Accepted; amends 0010). Amends spec 003's `overlayIndex` interface and Display rule.

**Open question (Gage, unanswered; doesn't block this fix).** What CRS is your imagery, and do the strips sit on the 256-pixel tile grid? Irregular bands may instead be imagery nodata, which is never labelled (spec 003).

## Defect
Each stored tile is drawn as its own canvas (`map/labelOverlay.ts`), sampled by `core/overlay.ts` `overlayIndex` on the Mercator grid that `core/warp.ts` `mercatorGrid` fits to that tile's own bounding box. An overlay pixel is opaque only if its centre falls in the tile. On grids rotated against Mercator (UTM off its central meridian), neighbouring tiles' pixel grids are offset by arbitrary fractions of a pixel. So along each shared edge some spots are painted by neither overlay (gaps up to about a raster pixel wide) and some by both (darker at `raster-opacity` 0.6). EPSG:4326 and 3857 grids align with Mercator and don't show it. The label store itself is correct.

## Scope
In: one Mercator cell grid per raster, sized to its finest pixel, with power-of-two coarser cells per tile where pixels are larger; overlap at seams where cell size steps; a Uint16 overlay index.
Out: the imagery and AlphaEarth previews; the hairlines left by MapLibre rounding each image source's corners independently (`image_source.ts` `_round()`, maplibre-gl 6.16.0), accepted in ADR 0016; showing a pixel that straddles ±`MAX_LAT` (only pixels wholly within it are guaranteed to show); a hard ceiling on overlay size; a custom WebGL layer.

## Interfaces (`core/`)
```ts
const OVERLAY_SAMPLE = 16;   // sample stride, raster px
const OVERLAY_MARGIN = 0.98;
pixelWidths(grid: Grid, col: number, row: number): [number, number] | null
  // Mercator a = M(c+1, r) - M(c, r), b = M(c, r+1) - M(c, r); [|a×b| / (|ay| + |by|), |a×b| / (|ax| + |bx|)]; null unless wholly within ±MAX_LAT
type OverlayGrid = { px: number; py: number; k: Map<string, [number, number]> } // k by LabelStore key: powers of two
overlayGrid(grid: Grid): OverlayGrid
  // samples: in every tile window, cols x0, x0 + 16, ..., and its last col, times the same for rows
  // px, py = OVERLAY_MARGIN x min over all samples of wx, wy; tile k = largest powers of two with k·p <= OVERLAY_MARGIN x its own min
  // (1 if it has no sample within ±MAX_LAT)
overlayIndex(w: Window, grid: Grid, og: OverlayGrid): { index: Uint16Array; valid: Uint8Array; width: number; height: number; corners: [number, number][] }
  // cells kx·px by ky·py, edges at integer multiples from Mercator (0, 0); valid bit i (i >> 3, i & 7) = cell painted by w;
  // index = w-tile index of the raster pixel holding the cell centre, or of w's pixel nearest it (clamped) for an extra cell
paintOverlay(index: Uint16Array, valid: Uint8Array, labels: Uint8Array, colours: string[], rgba: Uint8ClampedArray): void
```
`overlayIndex(w, grid, maxSide)`, `overlayPitch` and spec 003's "same Mercator grid as warpPreview" are replaced. `LabelOverlays` computes `overlayGrid` once when the raster opens.

**Rules.**
- **Who paints a cell.** Tile w paints a cell whose centre lies in w. It also paints a cell that intersects w's footprint when the cell's centre lies in a neighbouring tile (any of 8) whose cells are smaller than w's in either axis. Equal-size neighbours partition cells exactly. Where sizes step, the coarser tile covers the seam: no gaps, but up to one coarse cell is drawn twice (darker at 0.6), accepted.
- **Precision.** Every raster pixel wholly within ±`MAX_LAT` contains the centre of at least one valid cell of its own tile's overlay whose index is that pixel.
- **Cost.** About 3 projections per sample (289 per full tile): an estimated 2.5 s at open for a 20,480 px square UTM raster (6,400 tiles), scaling with pixel count. The estimate comes from a measured 0.4 s for 845k projections. Sampling misses the minimum only where pixel widths vary by more than 2% within 16 px away from tile edges, which for ADR 0002's CRSs happens only beside a stationary point (the equator or a central meridian), where the variation is second order.
- **Memory.** Per overlay cell: 4 B canvas, 2 B index, 1/8 B validity (CPU), plus 4 B GPU texture. Typical local rasters have all tiles at k = 1 and overlays 260-300 px a side (~0.4-0.53 MiB), about 101-135 MiB at the 256-tile cap. High-latitude EPSG:4326 (0.01° near 85°) is about 256 x 640 px, ~245 MiB at the cap. There is no hard ceiling: size grows with how much pixel size varies within a tile.
- **Tests.** The tester's `it.fails` and the "known gap" test in `tests/unit/core/overlaySeams.tester.test.ts` are replaced by criteria 3 and 5.

## Acceptance criteria
1. Partition (unit, regression): build overlays for a fully labelled 2x2 block of tiles on three grids: spec 003's EPSG:32633 fixture; a synthetic EPSG:32633 grid 3° from the central meridian at 60°N (10 m pixels); and a synthetic EPSG:4326 grid at 45°N. All their tiles have k = [1, 1]. For 10,000 seeded random points inside the block's footprint and at least 2 raster pixels from its outer edge, exactly one overlay has a valid cell covering the point (located from its corners, width and height). On the pre-fix code the first two grids fail.
2. Completeness (unit, brute force on the synthetic UTM grid): every cell whose centre maps (Mercator to lon/lat, `fromLonLat`, inverse gt, floor) to a pixel of tile w is valid in w's overlay, with that pixel's index.
3. Precision (unit, brute force over every pixel): the Precision rule holds on criterion 1's grids and on these:
   - the tester's `{ epsg: 4326, gt: [10, 0.01, 0, -45, 0, -0.01], width: 300, height: 520 }`;
   - an EPSG:4326 grid of 0.01° pixels, 600x600, from 87°N down (crossing `MAX_LAT`);
   - an EPSG:4326 grid of 0.01° pixels from 60°N to 85°N, where k steps;
   - an EPSG:32633 grid with rotation and shear terms in gt.

   `overlayGrid`'s px and py are within 2% of the brute-force minimum over all pixels, and never above it.
4. No gaps where k steps (unit, the 60-85°N grid, fully labelled 2x2 blocks straddling a k change): every seeded random point inside a block, at least 2 raster pixels from its outer edge, is covered by at least one valid cell, and by two only within one coarse cell of the seam. Spec 003 criterion 6 holds with the new functions; colours and alpha as before.
5. Size (unit): every kx and ky is a power of two; each overlay's width and height are at most ceil(bbox side / (k·p)) + 2; on criterion 1's grids, at most 300. `index.length` equals width x height and `valid.length` equals ceil(width x height / 8).
6. Display (e2e, `tests/e2e/label-seams.spec.ts`, `test.fail()` removed): on the synthetic EPSG:32633 grid as a single-value GeoTIFF, basemap hidden, at the zoom where one raster pixel is about 4 screen px, after one class is painted over a 2x2-tile block, `readPixels` samples 0.25 raster px either side of both seams, every 8 screen px along them (at least 900 samples). At most 2% of samples differ from the block interior's colour by more than 2 per channel. The pre-fix design differs on about 38% (382 of 1008), the shared grid on about 1% (10 of 1008).
