# 068: Export boxes as GeoJSON

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** none (no dependency). **Builds on specs 004, 050, 062 and 064.** It is part of the series in spec 062.

## Decided (Gage, 2026-11-12: the recommended answers)
1. **CRS.** EPSG:4326 lon/lat only. RFC 7946 §4 fixes WGS 84, and Appendix B removed the `crs` member (checked 2026-11-12). Each feature's properties hold its exact pixel box, so nothing is lost. There is no second file in the raster's CRS.
2. **Precision.** Full doubles, with no rounding. RFC 7946 §11.2 notes that 6 decimals is about 10 cm, which is coarser than a drone pixel.

**Goal:** Export boxes writes every box as a GeoJSON polygon on the map, with its class and exact pixel box, and nothing leaves the device.

## Scope
1. **Button.** `<button id="export-boxes">Export boxes</button>` sits in `#file-actions` after `#export-labels`.
   - It is listed in the `box` kind's sections, so it shows only in Boxes.
   - It is disabled with no boxes, while the labels are locked, and while they are busy, as `#export-labels` is.
2. **Run.**
   - A click calls `openSink("boxes.geojson", folder, GEOJSON_TYPE)` within the click. The save dialog opens in the imagery's folder on Chromium (spec 050 scope 3), and elsewhere the file downloads (ADR 0001's fallback).
   - A cancelled dialog does nothing, as Export labels does.
   - Once the dialog returns, spec 004's lock is held until the file closes, so no box changes mid-write.
   - Success says `Exported <n> boxes.` A failure aborts the sink and says why (`readErrorMessage`).
3. **Document.** One FeatureCollection, written as UTF-8 in batches of 1,000 features:
   - foreign members (RFC 7946 §6.1):
     - `raster`: `{ name, width, height, epsg, gt }`;
     - `classes`: `[{ value, name, colour }]` for every class;
   - `features`, one per box in id order:
     - `type: "Feature"`;
     - `id`: the box id;
     - `properties`: `{ value, class, pixel_bbox: [x0, y0, x1, y1] }`;
     - `geometry`: as scope 4.
4. **Geometry.**
   - The ring is the box's 4 pixel-edge corners `(x0,y0) (x1,y0) (x1,y1) (x0,y1)`, each through `applyAffine(gt, …)` then `toLonLat(epsg, …)`.
   - It is closed, and reversed when its signed area is negative, so the exterior ring is counter-clockwise (§3.1.6) whatever the geotransform's signs.
5. **Antimeridian (§3.1.9).** `toLonLat` keeps longitudes within 180° of the CRS's central meridian, so in UTM zones 1 and 60 they can pass ±180.
   - A ring wholly beyond ±180 is shifted by ∓360.
   - A ring that straddles 180 (or −180) is clipped into its two sides at that meridian. Latitude is interpolated linearly along each crossing edge, and the far side is shifted by 360. The result is a MultiPolygon of the two closed, counter-clockwise rings.
   - Every output longitude lies within [−180, 180].

**Out of scope:** the raster's CRS, shapefiles or GeoPackage, mask polygons (vectorising tiles), importing GeoJSON boxes, densified edges.

## Interfaces
- `core/boxExport.ts` (pure):
  - `boxRing(box: Rect, grid: Grid): [number, number][]` (closed, counter-clockwise, unwrapped);
  - `splitAntimeridian(ring): GeoJSON.Polygon | GeoJSON.MultiPolygon`;
  - `boxFeature(box: Box, grid: Grid, classes: LabelClass[]): GeoJSON.Feature`;
  - `geojsonHead(raster: { name: string } & Grid, classes: LabelClass[]): string` and `GEOJSON_TAIL`.
- `io/sink.ts`: `openSink(name: string, startIn?: FileSystemHandle, type = GEOTIFF_TYPE)`. `GEOJSON_TYPE` is `{ description: "GeoJSON", accept: { "application/geo+json": [".geojson"] } }`.
- `ui/boxExport.ts` wires the button and the run.

## Acceptance criteria
1. **Unit (boxRing):**
   - On a UTM grid, each corner equals `toLonLat(epsg, ...applyAffine(gt, x, y))` exactly.
   - The ring has 5 points, the first equal to the last, with positive signed area. That holds for a north-up gt and for one with `gt[5] > 0`.
2. **Unit (splitAntimeridian):**
   - On EPSG:32660, a box straddling 180° gives a MultiPolygon of 2 closed counter-clockwise rings. All longitudes are within [−180, 180], the two rings meet at ±180, and the sum of their areas in degrees equals the unwrapped ring's to 1e-9.
   - A ring wholly past 180 is shifted to a Polygon.
   - A ring not near 180 is returned unchanged.
3. **Unit (boxFeature, geojsonHead):**
   - Head, features and tail joined parse as JSON.
   - `pixel_bbox` equals the box, `class` is the class name, and the foreign members hold the raster's grid and every class.
4. **Unit (io/sink):** spec 050 criterion 1 still passes with no `type`. With `GEOJSON_TYPE`, the picker options' `types` is `[GEOJSON_TYPE]`.
5. **E2E (faked save picker as in spec 050 criterion 3):**
   - Draw 2 boxes in two classes and export. The written file parses, has 2 features with those class names and pixel boxes, and its `startIn` is the imagery handle.
6. **E2E:**
   - `#export-boxes` is hidden in Masks.
   - In Boxes it is disabled with no boxes, and enabled after a box is drawn.
   - While the export's sink is paused, a box drag changes nothing.
7. `npm run check` passes. Spec 050's e2e criteria pass.
8. **Docs:** the README describes Export boxes (EPSG:4326, with pixel boxes in the properties), and the CHANGELOG gets an entry.
