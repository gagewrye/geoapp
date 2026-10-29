# 018: The hover outline matches the pixels a dab paints

**Goal:** The brush footprint outline covers exactly the overlay cells that a click there colours, at any display scale.

**Status:** Draft for Gage (2026-10-29). The defect, in his words: "The pixel selector visual is also slightly misaligned with the map. It shows as shifted down and right relative to the pixel it will color." He then added: "Just the outline is off. It still marks where the cursor is at." His Windows display scale is 125% (devicePixelRatio 1.25). **ADRs:** none. Amends spec 003 Hover.

**Open questions (each has a recommended default):**
1. **The cause is predicted, not observed.** Is the gap at most about half a raster pixel, and does it grow as you zoom in? If so, it is the cause below. If instead it stays a fixed few screen pixels at every zoom, it is a rendering fault, and this spec goes back to the architect. Default: proceed. The implementer runs criterion 1 first and reports the measured offsets before any fix.
2. **Which fix?** Default: (a), with these options:
   - (a) Snap the outline to the cells that will be painted. This is cheap, it is exactly what Gage asked for, and it works in any CRS.
   - (b) Halve the overlay cell size. Labels sit within 0.25 px of their true place, but overlay memory grows about 4x, to about 400-540 MiB at the cap.
   - (c) A custom WebGL label layer. This is exact, but it needs a new ADR and replaces spec 011's grid.
3. What CRS is your imagery? This is spec 011's unanswered question. On a rotated grid, such as UTM, fix (a) draws a stepped outline.

## Cause (found by reading the code; maplibre-gl 6.16.0)
- **The outline is exact.** `footprintRing` traces the outer pixel edges of the same `footprint` window that `brush` paints. The pointer maps to its cell in CSS pixels through the canvas rect, as `unproject` does.
- **The painted colour is not exact.** Spec 011 draws each label on a shared Mercator cell grid:
  - Each cell is `OVERLAY_MARGIN` 0.98 of the finest pixel, with edges at multiples of the cell size from Mercator (0, 0).
  - Each cell shows the pixel that holds its centre (`core/overlay.ts` `overlayIndex`).
  - So each painted edge sits up to half a cell (about 0.49 px) from the true pixel edge.
  - The cell pitch differs from the pixel pitch by 2%, so the error drifts only slowly, over about 50 px. Locally it is one consistent shift: the colour lands up-left of the outline, so the outline looks shifted down and right.
  - The store and exports are exact; only the display is off.
- **Display scale is not the cause.**
  - Nothing in `src/` rounds to device pixels.
  - MapLibre's `_resizeCanvas` makes the canvas `round(dpr·w)` device px, with a CSS size within 0.4 px of the container.
  - So the same offset should show at 100%. Criterion 4 checks this at 1, 1.25 and 1.5.
- **Test helper bug.** The spec 015 clue, a reading one row above the screenshot pixel, comes from `tests/e2e/helpers.ts` `pixelAt` and from `label-seams.spec.ts`. They read GL row `round(canvas.height − y·sy)`, where the right row is `canvas.height − 1 − floor(y·sy)`. That bug is test-only, but criterion 4 needs it fixed.

## Interfaces (`core/`)
```ts
footprintCells(w: Window, grid: Grid, og: OverlayGrid): [number, number][][]
  // lon/lat rings, one per tile w meets: the outer boundary of the overlay cells (that tile's k)
  // whose centre lies in w; rectilinear in Mercator; a rectangle on axis-aligned grids
```

**Rules.**
- **Hover** shows `footprintCells` of the clipped footprint as one MultiPolygon feature, with the same fill, line and colour as before, in place of `footprintRing`.
  - It still reads nothing, and it shows and hides exactly as spec 003 Hover says.
  - Spec 011's extra seam cells, which a coarser tile paints in a finer neighbour, are not outlined. At such seams the outline can differ from the painted colour by up to one coarse cell, which is accepted.
- **Cost.** About (side + 2)² projections per update: an estimated 8 ms at 127 px, from spec 011's 0.4 s per 845k projections. This is fine at pointer-move rates.
- **Helper.** `pixelAt` and the seams test read column `floor((x − left)·sx)` and row `canvas.height − 1 − floor((y − top)·sy)`. Existing pixel tests must still pass.

## Acceptance criteria
1. Diagnosis (unit, run first; its numbers go in the implementer's report): on spec 011's synthetic EPSG:4326 and EPSG:32633 grids, over every pixel of a 2x2-tile block, measure the largest distance between a pixel's true Mercator edges and the edges of its centre-owned cells. It is at least 0.3 px somewhere, and at most 0.5 cell everywhere.
2. `footprintCells` (unit, brute force on the same grids, sizes 1, 7 and 127, including a footprint across a tile corner): a cell centre lies inside a returned ring exactly when it is a cell whose centre lies in w. On an EPSG:3857 grid each ring is the rectangle of those cells.
3. Hover feature (e2e): the hover source's geometry equals `footprintCells` at `pixelAt` of the pointer, within 1e-9°. Spec 003 criterion 9's show and hide cases still hold.
4. Regression (e2e, Playwright `deviceScaleFactor` 1, 1.25 and 1.5; EPSG:4326 fixture and spec 011's UTM GeoTIFF; zoom where a raster pixel is about 8 CSS px; basemap hidden; sizes 1 and 7):
   - The test picks a pointer pixel where criterion 1's offset is at least 0.3 px in both axes.
   - It finds the hover fill's extent along a row and a column through the pointer, by comparing with the same render without hover. Then it clicks, moves the pointer off the map, and finds the painted extent the same way.
   - All four edges agree within 1 device px.
   - On the pre-fix code, this fails at 1.25.
5. Helper (e2e, `deviceScaleFactor` 1.25): `pixelAt` at a point equals the page screenshot's pixel there within 2 per channel (spec 015 criterion 3's check), with no row offset.
