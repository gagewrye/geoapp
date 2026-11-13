# 018: Painted labels land exactly on the outlined pixels

**Goal:** The colour a dab paints covers exactly the raster pixels the hover outline marks, in any CRS, at any zoom and display scale.

**Status:** Approved (Gage, 2026-10-29: "yes approve both"), with ADR 0019 (Accepted; supersedes ADR 0016). This is the third revision. The earlier ones, an outline snapped to the overlay cells (`footprintCells`) and a cursor-hotspot fix, were never merged and are dropped. Amends spec 003 Display and criterion 6, and spec 011: criteria 1-5 lapse and criterion 6 holds. Written against main 768e958. Amended by spec 048 (2026-11-01): in criterion 5, "each stored tile" becomes "each stored tile with an overlay" (at most 256, ADR 0033).

**Amended by spec 052 (2026-11-02):** criterion 3's e2e test runs on one raster, the EPSG:32633 one, at the first 10 of its 40 positions. `label-quads.tester.spec.ts` checks dab = outline on EPSG:4326 at 45°N and 84°N.

**Amended by spec 061 (2026-11-12):** `label-quads.tester.spec.ts` is deleted, and criteria 3 and 5 are checked on UTM only: `label-alignment` 79 and 124 (EPSG:32633). Unit `labelQuads*` check the quad math. Lost: dab = hover on the globe on EPSG:4326, which spec 052 relied on; rendering of 128-quad tiles; and mask-tile quads drawn above the mask.

**What Gage reported** (testing main, display scale 125%):
- "The highlight is under the pointer and correct. When it paints it is off. Its weird, the direction of the offset seems to change based on the area selected."
- The offset is about one or two image pixels, the same at every zoom, and the pre-009 build (90f8f00) has it too.
- His answer to the deciding test: with brush size 1, the colour spills partly outside the outline's square.

## Cause (traced in the code)
- **The cells written are exact.** The hover and the paint both use `cellAt`, then `footprint(grid, col, row, side)` (`map/brush.ts`). Sizes are odd and the centre pixel is floored, the paint queue applies the same window, and `brush` writes exactly its pixels. The outline, `footprintRing` of that window, is at the true pixel edges.
- **Where they are drawn is not.** Main (spec 011, ADR 0016) resamples each stored tile onto Mercator cells 0.98 of the finest pixel wide, and each cell shows the pixel holding its centre (`core/overlay.ts` `overlayIndex`).
  - So each painted edge sits up to half a cell from the true edge. The direction of that error drifts with position, through the 2% pitch mismatch, the k steps and the steps on rotated grids.
  - Spec 003's per-tile grid, as built in 90f8f00, had the same flaw with coarser cells: 1/cos φ px wide on EPSG:4326 (2 px at 60°), and (cos θ + sin θ) px on rotated grids.

## Interfaces (`core/`)
```ts
type Quad = { window: Window; corners: [number, number][] } // lon/lat of the window's pixel-grid corners TL, TR, BR, BL
tileQuads(grid: Grid, w: Window, maxErr: number): Quad[]
  // splits w into 2^b x 2^c bands (fewest first) so that bilinear interpolation of each band's corners, in
  // Mercator, puts every pixel corner within maxErr x that pixel's width of its true position; row-major
paintLabels(labels: Uint8Array, colours: string[], rgba: Uint8ClampedArray): void // one texel per pixel; 0 transparent
```
Removed from main: `overlayGrid`, `overlayIndex`, `paintOverlay`, `pixelWidths`, `OVERLAY_SAMPLE` and `OVERLAY_MARGIN`, and the open-time `overlayGrid` call in `map/labelOverlay.ts`.

**Rules.**
- **Display.** `LabelOverlays` draws each stored tile as `tileQuads(grid, w, 0.05)`.
  - Each quad is a canvas of its window's pixels, painted by `paintLabels`.
  - It is a canvas source with the quad's corners and `setWarp('flat')` (maplibre-gl 6.16.0), raster layer with nearest resampling, `LABEL_OPACITY`, and the slot `label-`.
  - Layer ids are `label-${key}` for a single quad, else `label-${key}-${i}`. Spec 016's view applies to every `label-` layer, so it covers these too.
  - Spec 014's mask layer and its hidden cells are unchanged.
- **Hover** stays `footprintRing`, as on main. Its GeoJSON source gains `maxzoom: 24` and `tolerance: 0`, so overzoomed tiles neither round nor simplify the ring.
- **Seams.** Neighbouring quads share corner positions, so they meet without gaps or overlap. Only MapLibre's per-source corner rounding is left (the hairlines ADR 0016 accepted).
- **Test helper.** `pixelAt` in `tests/e2e/helpers.ts` and the seams test read column `floor((x − left)·sx)` and row `canvas.height − 1 − floor((y − top)·sy)`. Main reads one row high.

## Acceptance criteria
1. `tileQuads` (unit, brute force over every pixel corner): the bilinear error is at most 0.05 px on each of these grids:
   - spec 011's fixtures (EPSG:32633, the synthetic UTM grid at 60°N, 4326 at 45°N, 0.01° 4326 from 60°N to 85°N, and gt with rotation and shear);
   - an EPSG:3857 grid.

   The 32633 and 45°N tiles each give one quad. Quads tile the window exactly, and a quad's corners equal `footprintRing`'s corners of its window, within 1e-9°.
2. `paintLabels` (unit): a labelled pixel gets its class colour at alpha 255, and 0 gets alpha 0, texel for texel.
3. **Regression** (e2e; it must fail on main):
   - Setup: `deviceScaleFactor` 1.25; basemap hidden; zoom where a pixel is about 16 CSS px.
   - Rasters, all generated: an EPSG:32633 GeoTIFF placed 3° off its central meridian, an EPSG:4326 one at 45°N and one at 60°N.
   - Placement: dabs of sizes 1 and 7 at 40 positions per raster. At least 10 of them are where main's `overlayIndex` puts a painted edge 0.3 px or more from the true pixel edge.
   - After each dab, with the pointer off the map, check sample points every 2 device px over the outline's bounds plus 8 px:
     - points at least 1.5 device px inside the projected `footprintRing` show the class colour;
     - points at least 1.5 device px outside it, in unpainted space, show none.
   - Where practical, the tester also runs it, adapted to the old hooks, on 90f8f00, where it is expected to fail on the 4326 rasters.
4. Seams (e2e): spec 011 criterion 6 passes, with at most 2% of seam samples off.
5. Layers (e2e): on the 32633 and 45°N rasters, each stored tile adds exactly one `label-` layer, and spec 013 criterion 5's layer order holds.
6. Existing (e2e): spec 003 criteria 9 and 10, spec 010 criterion 3 and spec 014 criteria 6, 7 and 11 pass. Spec 003 criterion 6 is met by criteria 1 and 2 here.
