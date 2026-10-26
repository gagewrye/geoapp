# 001: Logistic regression v1

**Goal:** Classify a local GeoTIFF in the browser with a logistic regression model trained on user-drawn labels.

**ADRs:** 0001 tiled TIFF writer, 0002 proj4 + warped preview, 0003 terra-draw (all Proposed).

**Open questions (for Gage; recommendations in brackets)**
1. Output size cap: classic TIFF (< 4 GiB, roughly 65k x 65k px), or add BigTIFF now? [Classic now, BigTIFF later.]
2. CRS support limited to EPSG:4326, 3857 and WGS84 UTM? [Yes for v1.]
3. Drawing: terra-draw, or a hand-rolled tool? [terra-draw.]
4. Cap on training samples? [No cap in v1. Memory grows with labeled area, not raster size.]

## Scope
In: open a local GeoTIFF/COG, show a preview on the map, draw labeled polygons, train, classify, export a GeoTIFF, save/load model JSON.
Out: search, catalog, publishing, cloud compute, Earth Engine, ONNX, deep models, picking band combinations (preview uses bands 1-3, or band 1 as greyscale), viewing the classified result on the map, BigTIFF/compressed output, CRSs outside ADR 0002.

## Interfaces (`core/`)
```ts
const EPS = 1e-6;
type Model = { version: 1; type: "logreg";
  bands: number[];      // 1-based raster band indices used, any subset
  mean: number[]; std: number[];  // per used band; fit stores max(std, EPS)
  classes: string[];    // 2..255; index = output value
  W: number[][]; b: number[]; };  // W: [classes][bands.length], b: [classes]
type Tile = { x0: number; y0: number; width: number; height: number; // raster pixel offset/size
  bands: Float32Array[]; nodata: number | null }; // all bands, index = band-1, row-major
type Affine = [number, number, number, number, number, number]; // GDAL order: x = a + b*col + c*row, y = d + e*col + f*row
type PixelPolygon = { rings: [number, number][][]; label: number }; // raster [col,row]; ring 0 outer, rest holes

toPixelPolygons(features: GeoJSON.Feature<GeoJSON.Polygon, { label: number }>[], epsg: number, gt: Affine): PixelPolygon[]
samplePixels(tile: Tile, polygons: PixelPolygon[], bands: number[]): { X: Float32Array; y: Uint8Array } // X row-major [n][bands.length]
fit(X: Float32Array, y: Uint8Array, bands: number[], classes: string[], opts?: { epochs?: number; lr?: number; l2?: number }): Model
predictTile(model: Model, tile: Tile): Uint8Array   // softmax argmax per pixel; 255 = nodata
validate(model: unknown, bandCount: number): asserts model is Model  // throws Error naming the bad field
warpPreview(src: Tile, gt: Affine, epsg: number, maxSide: number): { rgba: Uint8ClampedArray; width: number; height: number; corners: [number, number][] }
```
**Rules.** A pixel (col,row) is inside a polygon when its centre (col+0.5, row+0.5) is inside under the even-odd rule. Each pixel belongs to exactly one tile, so a polygon that crosses tiles is sampled tile by tile and every pixel appears once. A pixel covered by polygons with different labels is dropped. A pixel is nodata when any *model* band equals `tile.nodata` or is NaN. Sampling skips nodata pixels, and prediction writes 255 for them. `io/` reads 256x256 windows aligned to the output tile grid. Training reads only the windows that intersect a polygon's bounding box. The preview is built tile by tile by decimation and never reads the full-resolution raster at once.

## Acceptance criteria
1. Opening, training, classifying and exporting make no network requests except for the app's own static files (Playwright request log).
2. Users can draw polygons and give each a class name (e2e).
3. `toPixelPolygons` maps the fixture's reference lon/lat points (EPSG:4326, 3857, 32633) to their recorded pixel coordinates within 0.01 px. An unsupported EPSG code throws.
4. `warpPreview` on a UTM fixture places a known feature within 1 preview pixel of its reference lon/lat. Its corners form a rectangle in Mercator.
5. `samplePixels`: pixels are included by the centre rule, holes are excluded, and nodata/NaN pixels and conflicting-label pixels are dropped. Sampling a polygon over a 2x2 tile grid gives the same multiset of samples as sampling the same area as one tile.
6. `fit` reaches at least 95% train accuracy on a linearly separable synthetic set. A constant band gives `std = EPS`, and `W`/`b` contain no NaN.
7. `predictTile` matches a precomputed reference output on a fixed tile and model, including 255 at nodata pixels.
8. Training and classification on an instrumented 2048x2048 source only request windows of at most 256x256. Training requests only windows that intersect a polygon's bounding box. Every sink write after the header is at most 65,536 bytes.
9. geotiff.js reads the exported file back with the same width, height, origin, resolution and GeoKeys as the input, 256x256 tiles, GDAL_NODATA "255", and pixels equal to `predictTile`. A raster whose output would exceed the classic-TIFF limit is rejected before anything is written.
10. Model JSON round-trips: save, load, and predictions are identical.
11. `validate` accepts a valid model that uses a subset of the raster's bands. It rejects each of these: version not 1 or type not "logreg"; a band index that is not an integer, is below 1, is above `bandCount`, or is duplicated; `mean`, `std` or a `W` row whose length differs from `bands.length`; a `W` or `b` length that differs from `classes.length`; fewer than 2 or more than 255 classes; `std` at or below 0; any non-finite number.
