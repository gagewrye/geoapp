# 001: Logistic regression v1

**Goal:** Classify a local GeoTIFF in the browser with a logistic regression model trained on user-drawn labels.

**Status:** Approved (Gage, 2026-10-26). Partly superseded by spec 003 (approved 2026-10-26): the brush replaces polygon labelling, and criteria 2, 3, 5 and 13-15, plus the polygon parts of 8 and 12, no longer apply (see spec 003, "Polygons removed"). Partly shelved by spec 013 (2026-10-28), lapsed: all but raster open, preview, globe, and criteria 1, 4, 12's globe checks and 16.

**Amended by spec 061 (2026-11-12):** `edges.spec.ts`, criterion 12's globe check, is deleted. Criterion 12 stays covered by `globe.spec.ts` (projection, and the preview at zoom 3 and at the known feature at zoom 14). `brush-180.tester` keeps only its stroke across 180, which opens criterion 16's zone 60 raster.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `workflow` (criterion 16, rasters at 180°), `globe` (criterion 12) and `brush-180.tester` (criterion 16's zone-60 raster); unit `io/pipeline.edge` (criteria 8 and 16), `io/nodata.edge` (criteria 5, 7 and 9), `io/nodata.inf.edge` and `core/warp.stretch`. The base unit tests of the pipeline, nodata, warp and CRS code stay. No e2e test opens a raster or checks the globe as its subject any more.

**ADRs (all Accepted):** 0001 tiled TIFF writer, 0002 proj4 + warped preview, 0003 terra-draw, 0004 MapLibre >= 6.16 with globe.

**Decided (Gage):** classic TIFF output only, BigTIFF/compression later (0001); CRSs EPSG:4326, 3857 and WGS84 UTM, more later (0002); no cap on training samples; `core/` may import proj4; globe map projection (0004); polygons crossing ±180° or beyond ±`MAX_LAT` are blocked with a message, never silently dropped or clamped (0003); EPSG:4326/3857 rasters whose extent crosses ±180° are refused on open.

## Scope
In: open a local GeoTIFF/COG; show a preview on a MapLibre globe that becomes flat Mercator when zoomed in; draw labeled polygons; edit them with terra-draw select mode (move vertices, drag, delete); train; classify; export a GeoTIFF; save/load model JSON.
Out: search, catalog, publishing, cloud compute, Earth Engine, ONNX, deep models, choosing preview bands (bands 1-3, or band 1 as greyscale), showing the classified result on the map, BigTIFF/compressed output, CRSs outside ADR 0002, drawing holes. Polygons crossing ±180° and vertices beyond ±`MAX_LAT` are blocked with a message, not silently unsupported (v1 limits); users draw one polygon on each side of 180° instead. EPSG:4326/3857 rasters whose extent crosses ±180° are refused on open (v1 limit).

## Interfaces (`core/`)
```ts
const EPS = 1e-6;
const MAX_LAT = 85.051129; // Web Mercator limit; MapLibre renders nothing beyond it (ADR 0004)
type Model = { version: 1; type: "logreg";
  bands: number[];      // 1-based raster band indices used, any subset
  mean: number[]; std: number[];  // per used band; fit stores max(std, EPS)
  classes: string[];    // 2..255; index = output value
  W: number[][]; b: number[]; };  // W: [classes][bands.length], b: [classes]
type Tile = { x0: number; y0: number; width: number; height: number; // raster pixel offset/size
  bands: Float32Array[]; nodata: number | null }; // all bands, index = band-1, row-major
type Affine = [number, number, number, number, number, number]; // GDAL order: x = a + b*col + c*row, y = d + e*col + f*row
type PixelPolygon = { rings: [number, number][][]; label: number }; // raster [col,row]; ring 0 outer, rest holes

checkRing(ring: [number, number][]): "antimeridian" | "latitude" | null // lon/lat ring, closed or open
toPixelPolygons(features: GeoJSON.Feature<GeoJSON.Polygon, { label: number }>[], epsg: number, gt: Affine): PixelPolygon[]
samplePixels(tile: Tile, polygons: PixelPolygon[], bands: number[]): { X: Float32Array; y: Uint8Array } // X row-major [n][bands.length]
fit(X: Float32Array, y: Uint8Array, bands: number[], classes: string[], opts?: { epochs?: number; lr?: number; l2?: number }): Model
predictTile(model: Model, tile: Tile): Uint8Array   // softmax argmax per pixel; 255 = nodata
validate(model: unknown, bandCount: number): asserts model is Model  // throws Error naming the bad field
warpPreview(src: Tile, gt: Affine, epsg: number, maxSide: number): { rgba: Uint8ClampedArray; width: number; height: number; corners: [number, number][] }
```
**Rules.** A pixel (col,row) is inside a polygon when its centre (col+0.5, row+0.5) is inside under the even-odd rule. Each pixel belongs to exactly one tile, so every pixel is sampled once. Pixels covered by polygons with different labels are dropped. A pixel is nodata when any *model* band equals `tile.nodata` or is NaN; sampling skips it and prediction writes 255. `io/` reads 256x256 windows aligned to the output tile grid; training reads only windows that intersect a polygon's bounding box. The preview is decimated tile by tile and never reads the full raster at once. The map style sets `projection: { type: "globe" }`.

**Blocking.** `checkRing` returns `"antimeridian"` if any edge, including the closing edge, spans more than 180° of longitude, else `"latitude"` if any vertex has |lat| > `MAX_LAT`, else null. Since longitudes stay in [-180, 180] and no edge wraps, a ring cannot encircle a pole. `map/` passes one validation to `TerraDrawPolygonMode` and to the polygon flags of `TerraDrawSelectMode`; it rejects every update type when `checkRing` is non-null, so the update is not stored (ADR 0003). `ui/` then shows "Polygons can't cross the 180° meridian. Draw one on each side instead." or "Polygons can't extend beyond 85° north or south." Opening an EPSG:4326 or 3857 raster whose extent (from its geotransform corners) goes past ±180° longitude (3857: |x| > 20037508.34 m) is refused before any tile is read, and `ui/` shows "Rasters crossing the 180° meridian aren't supported yet." An edge exactly at ±180° is allowed. UTM rasters are unaffected, since proj4 reduces longitude relative to the zone meridian.

## Acceptance criteria
1. Opening, training, classifying and exporting make no network requests except for the app's own static files (Playwright request log).
2. Users can draw polygons and give each a class name (e2e).
3. `toPixelPolygons` maps the fixture's reference lon/lat points (EPSG:4326, 3857, 32633) to their recorded pixel coordinates within 0.01 px. An unsupported EPSG code throws.
4. `warpPreview` on a UTM fixture places a known feature within 1 preview pixel of its reference lon/lat. Its corners form a rectangle in Mercator.
5. `samplePixels`: pixels are included by the centre rule, holes are excluded, and nodata/NaN and conflicting-label pixels are dropped. Sampling a polygon over a 2x2 tile grid gives the same multiset of samples as sampling it as one tile.
6. `fit` reaches at least 95% train accuracy on a linearly separable synthetic set. A constant band gives `std = EPS`, and `W`/`b` contain no NaN.
7. `predictTile` matches a precomputed reference output on a fixed tile and model, including 255 at nodata pixels.
8. Training and classification on an instrumented 2048x2048 source only request windows of at most 256x256, training only those intersecting a polygon's bounding box. Every sink write after the header is at most 65,536 bytes.
9. geotiff.js reads the exported file back with the same width, height, origin, resolution and GeoKeys as the input, 256x256 tiles, GDAL_NODATA "255", and pixels equal to `predictTile`. A raster whose output would exceed the classic-TIFF limit is rejected before anything is written.
10. Model JSON round-trips: save, load, and predictions are identical.
11. `validate` accepts a valid model that uses a subset of the raster's bands. It rejects each of: version not 1 or type not "logreg"; a band index that is not an integer, below 1, above `bandCount`, or duplicated; `mean`, `std` or a `W` row whose length differs from `bands.length`; a `W` or `b` length that differs from `classes.length`; fewer than 2 or more than 255 classes; `std` at or below 0; any non-finite number.
12. Globe (e2e): `map.getProjection().type` is `"globe"`. At zoom 3 the canvas pixel at the preview's centre is not the background colour, and at zoom 14 the same holds at a known feature's location. A polygon drawn by clicking four screen points, once at zoom 3 and once at zoom 14, yields vertices equal to `map.unproject` of those points within 1e-6°, up to a multiple of 360° in longitude.
13. `checkRing` (unit): an edge from lon 179 to -179, or a closing edge doing the same, gives `"antimeridian"`; an edge from -100 to 100 gives `"antimeridian"`; a vertex at lat 85.1 or -85.1 gives `"latitude"`; a ring with edges of exactly 180° and vertices at exactly ±`MAX_LAT` gives null.
14. Antimeridian (e2e), at zoom 3 and zoom 14: drawing or editing a polygon (adding, or dragging, a vertex, or dragging the polygon) so it would cross ±180° is blocked, the user sees the antimeridian message, and no invalid polygon is stored (`getSnapshot()`) or rendered (`map.queryRenderedFeatures`). A polygon drawn on each side of 180° is stored and rendered.
15. Latitude (e2e), on the globe: adding or dragging a vertex beyond ±`MAX_LAT` is blocked, the user sees the latitude message, and the stored polygon is unchanged. No vertex is clamped.
16. Raster at 180°: opening an EPSG:4326 fixture and an EPSG:3857 fixture whose extents cross ±180° is refused, the user sees "Rasters crossing the 180° meridian aren't supported yet.", and no tile is read (instrumented source). An EPSG:4326 fixture with an edge exactly at 180° and a UTM fixture in zone 60 (EPSG:32660) touching 180° both open.
