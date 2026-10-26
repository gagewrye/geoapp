# 004: Train on AlphaEarth from imagery labels

**Goal:** Transfer brush labels painted on local imagery onto a fetched AlphaEarth AOI, train spec 001's logistic regression on the 64 embedding bands, and classify and export the AOI on the AlphaEarth grid.

**Status:** Draft — awaiting Gage's approval. Needs spec 002 (AlphaEarth source) and spec 003 (brush labels). **ADRs:** 0011 drawn AOI + supersampled pure-label transfer (Proposed); uses 0001, 0002, 0005 and 0010. Open questions are at the end.

**Decided (Gage, 2026-10-26):** AlphaEarth is never hand-labelled; embeddings are only for training on. Labels on local or uploaded imagery can train a model on AlphaEarth if the user wants.

## Scope
In: a "Train on" choice between "Imagery bands" (spec 003, the default) and "AlphaEarth <year>"; label transfer; training; classifying the whole AOI; GeoTIFF export on the AOI grid; save/load model as in spec 001.
Out: an AOI taken from the imagery's extent or from the labels; models combining imagery bands with embeddings; several years or AOIs in one model; showing transferred labels or results on the map; transferring labels back to the imagery.

## Interfaces (`core/`)
```ts
const K_MAX = 8;
subsamples(src: Grid, aoi: Aoi): number // k = clamp(ceil(AEF_RES / s), 1, K_MAX); s = shorter side (m) of the src pixel at the AOI centre, projected to aoi.epsg
transferWindows(store: LabelStore, src: Grid, aoi: Aoi): Window[] // AOI tileWindows that can receive a label, row-major; may over-include, never misses
transferLabels(store: LabelStore, src: Grid, aoi: Aoi, w: Window, k: number): Uint8Array // labels for AOI window w, row-major; 0 = unlabelled
```
`Grid`, `LabelStore` and `labelSamples` come from spec 003, and `Aoi` comes from spec 002 (it has `Grid`'s shape).

**Rules.**
- **AOI.** The AOI is spec 002's drawn rectangle, or a local AlphaEarth file's grid. It is never the imagery's extent or the labels' bounding box, so requests depend only on what the user drew and the year (ADR 0005, 0011). Labels outside the AOI are ignored.
- **Transfer.** For AOI pixel (c, r), the sub-points are (c + (i+0.5)/k, r + (j+0.5)/k) for i, j in 0..k-1. Each goes through `aoi.gt` to UTM, then to lon/lat (`core/crs`), then through `pixelAt(src)`. A sub-point's label is the store value there, or 0 when it falls off the raster. The pixel gets class v when at least ceil(k²/2) sub-points are labelled and all of them are v. Otherwise it gets 0. At k = 1 this is the nearest-neighbour label at the pixel centre. Transfer reads only the label store, never an imagery window.
- **Training on AlphaEarth.** The "AlphaEarth <year>" option is enabled once AlphaEarth data is loaded (spec 002). Training reads each window of `transferWindows` once from the cache, computes `transferLabels` with k = `subsamples(src, aoi)`, applies `labelSamples` on bands 1..64, and fits every class in the list. It needs at least two classes with transferred samples, otherwise ui shows "Fewer than two classes have labels inside the AlphaEarth area." On success, ui shows "Trained on N AlphaEarth pixels."
- **Classify and export.** Both follow the "Train on" choice. For AlphaEarth, `predictTile` runs on every AOI window of the cache (or local file), and ADR 0001's writer writes the result on the AOI grid. There is no input TIFF to copy tags from, so `io/` builds them from `aoi`: GTModelType projected, GTRasterType PixelIsArea, ProjectedCSTypeGeoKey `aoi.epsg`, ModelPixelScale 10, ModelTiepoint at the `gt` origin. For "Imagery bands", specs 001/003 apply unchanged. "Load model" validates against the chosen source's band count.
- **Test data.** `make_aef_fixtures.py` also writes (e) `imagery.tif`, staying inside the 5 MB budget. It is a 3-band Uint8 EPSG:32617 GeoTIFF at 5 m that covers the (a) chip plus a 20 m margin. Its origin is offset 2.5 m in x and y from the 10 m grid, so k = 2 and the two grids don't align. Its RGB values are `aefPreview` of the reference chip, nearest neighbour. Cross-CRS transfer is unit-tested on synthetic grids and needs no file.

## Acceptance criteria
1. `subsamples`: an EPSG:32617 source grid with 10, 30, 3 and 0.5 m pixels gives 1, 1, 4 and 8 for an EPSG:32617 AOI.
2. Identity: when the source grid equals the AOI grid (k = 1), `transferLabels` returns the stored labels unchanged in every window.
3. Rule (2.5 m EPSG:32617 source aligned to the AOI, k = 4): 8 of 16 sub-points labelled 1 and the rest unlabelled gives 1; 7 gives 0; 15 labelled 1 plus one labelled 2 gives 0.
4. Reprojection (EPSG:4326 source at 4.5e-5° over the (a) chip, AOI EPSG:32617): with a 40x40-pixel block labelled 1, every AOI pixel whose centre lies at least 10 m inside the block's outline (projected to UTM) gets 1, and every one at least 10 m outside gets 0.
5. `transferWindows`: it contains every AOI window where `transferLabels` is non-zero, checked by brute force over all windows of a 2x2-window AOI with labels on a window corner. It returns [] for an empty store and for a store whose tiles all lie outside the AOI.
6. Reads (instrumented cache and imagery source): training on AlphaEarth reads exactly the cached windows in `transferWindows`, once each, and no imagery window. The sample count equals the non-zero transferred pixels that aren't NaN, and the model equals `fit` on those samples.
7. End-to-end (e2e, fixtures (a), (b) and (e)): open (e), paint two classes (by mouse and through `__geoapp.labels`), draw the AOI over the chip, fetch 2021, choose "AlphaEarth 2021", train, classify and export. `model.bands` is 1..64 and `model.classes` is the class list. The output is EPSG:32617 with origin `aoi.gt`, the AOI's width and height, 10 m pixels, 256x256 tiles and GDAL_NODATA "255". Its pixels equal `predictTile` on the cached tiles (255 where embeddings are NaN). This replaces spec 002's original criterion 11.
8. Local file (e2e): with the fixture (a) west-half COG opened as AlphaEarth data, training and export use that COG's north-up grid as the AOI. The output's origin and size equal that grid.
9. Choice and messages (e2e): "AlphaEarth" is disabled until AlphaEarth data is loaded. If only one class has labels inside the AOI, training shows the message and makes no model. With "Imagery bands", spec 003 criterion 16 still passes on (e).
10. Privacy (request log): for one AOI and year, the `AEF_BASE` requests (URL + Range) are identical in a session with no labels and in one with three classes painted, some of them outside the AOI. After the fetch, transfer, training, classification and export make zero requests.

## Open questions for Gage (recommended default first)
1. **AOI:** drawn rectangle. The imagery's extent would reveal a private raster's footprint unasked, and it fails above 20 km. The labels' bounding box would break ADR 0005.
2. **Transfer rule:** half coverage with a pure label, supersampled. Or the simpler centre nearest neighbour, which mislabels mixed pixels and misses thin strokes on fine imagery? Or a majority vote, which keeps mixed pixels?
3. **K_MAX = 8:** sub-metre strokes narrower than 1.25 m may be missed. Raise it, at k² cost?
4. **Model source:** `Model` is unchanged, so a loaded 3-band model passes `validate` on AlphaEarth, because subsets are allowed. Add a source tag to model JSON later (default), or now?
5. **Year:** the user picks it, with no check against the imagery's date. Do you want a warning?
