# 002: AlphaEarth embeddings source + classification

**Goal:** Fetch Google AlphaEarth annual embeddings for a user-drawn area and year, and classify them with spec 001's logistic regression.

**Status:** Approved (Gage, 2026-10-26). **ADRs (all Accepted):** 0005 AlphaEarth COGs from Source Cooperative + local AOI cache, 0006 static per-zone index, 0007 Python fixture script, 0008 interim fixtures from public data (pending Gage's review).

**Decided (Gage, 2026-10-26):**
- Models are simple regression only.
- Users fetch the embeddings themselves. The host is Source Cooperative, behind a configurable constant `AEF_BASE`, because Google's bucket sends no CORS headers (ADR 0005).
- `MAX_AOI_SIDE` is 2048 px.
- CLAUDE.md now allows public-dataset fetches that reveal only the area and year.
- There is no basemap in v1. Users label on the AlphaEarth false-colour preview.
- Fixture labels are committed with an attribution NOTICE.

**Follow-on specs:**
- 003 change detection: per-pixel cosine similarity between years, plus a threshold mask.
- 004 change prediction: logreg on [E(t-1), E(t)] predicting the class at t+1.
- AT Protocol: opt-in publishing and discovery of models, label sets and catalog entries under user-owned DIDs. Large files stay off-protocol and are linked. Private data stays local.

## Scope
In:
- Draw one AOI rectangle with terra-draw `TerraDrawRectangleMode`.
- Pick a year from the index.
- Download the AOI into an OPFS cache.
- Show a false-colour preview.
- Label, train, classify, export and save/load the model as in spec 001, on all 64 bands.
- Show the dataset's attribution.
- Open a local AlphaEarth COG (64 bands, Int8, GDAL_NODATA -128) through the same dequantizing reader.

Out:
- Change detection (spec 003) and change prediction (spec 004).
- AOIs spanning two UTM zones or hemispheres (blocked with a message).
- Multiple AOIs, Earth Engine, any basemap (satellite or otherwise; labeling uses the false-colour preview), showing results on the map, and models other than spec 001 logreg.

## Interfaces (`core/`)
```ts
const AEF_RES = 10; const MAX_AOI_SIDE = 2048; // px
type AefEntry = { year: number; epsg: number; path: string;   // path relative to AEF_BASE, e.g. "2017/10N/x0dy...-0000000000-0000000000.tiff"
  x0: number; y0: number; x1: number; y1: number };           // UTM bounds, metres
type Aoi = { epsg: number; gt: Affine; width: number; height: number }; // north-up (gt[5] < 0), 10 m grid
utmEpsg(lon: number, lat: number): number              // 326zz if lat >= 0 else 327zz; lon 180 -> zone 60
aoiGrid(ring: [number, number][]): Aoi | "zones" | "size" // lon/lat ring -> UTM bbox snapped outward to multiples of 10 m
selectEntries(index: AefEntry[], aoi: Aoi, year: number): AefEntry[] // bounds overlap with positive area
dequantize(q: Int8Array, out: Float32Array): void      // sign(q)*(q/127.5)^2; -128 -> NaN
aefPreview(tile: Tile): Tile  // 3 bands = A01, A16, A09 (1-based 2, 17, 10), linear [-0.3, 0.3] -> [0, 255], clamped
```

**Rules.**
- **Zone and size.** Every vertex of the AOI rectangle must give the same `utmEpsg`. Otherwise `aoiGrid` returns `"zones"` and ui shows "Areas must lie inside one UTM zone and hemisphere." A side over `MAX_AOI_SIDE` returns `"size"` and ui shows "Area too large (max 20 km per side)."
- **Reading COGs.** `io/` derives each COG's geotransform from its own GeoTIFF tags and does not use geotiff.js `getResolution`, which negates y. Rows of a bottom-up COG (positive y scale, the Source Cooperative layout) are flipped into the north-up AOI grid. A COG whose origin is not a multiple of 10 m from the AOI grid is refused. Pixels covered by no COG are NaN, and `Tile.nodata` is null.
- **Cache.** The fetch streams the whole AOI into an OPFS cache in row-major 256x256 windows. Each window is stored as raw Int8 (4 MiB) and dequantized on read. Preview, training and classification read only the cache, so the requests depend only on AOI and year.
- **Model.** The model is spec 001's `Model`, unchanged (`bands` 1..64).
- **Index.** `scripts/build_aef_index.mjs` parses `crs` "EPSG:N" to `epsg` and strips `s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/` from `path`; any other prefix fails the build. The full set is 43 MB, so only `years.json` and the EPSG:32617 shards are committed; deploys generate the rest with the script.

**Test data (ADR 0007; interim source ADR 0008).**
- Until Gage regenerates them from his chips, the committed fixtures are built by the same script from ADR 0008's stand-in chips: same format, AEF 2021 over the Everglades, labeled by ESA WorldCover 2021 (mangrove = class 10). The NOTICE then names that source and credits AlphaEarth and ESA WorldCover instead of the label sources below.
- `scripts/fixtures/make_aef_fixtures.py` reads mangrove-embed `data/chips/*/chip_NNNN.npz`: `x` float16 [64,128,128] (invalid pixels all zero), `y` uint8 1..11 with 255 = ignore, 10 m north-up UTM, and `index.csv` `x0,y1` as the upper-left corner. It writes `tests/fixtures/aef/`, at most 5 MB in total:
  - (a) One everglades chip (EPSG:32617), re-quantized to Int8 (all-zero vector -> -128) and split into three COGs: west half bottom-up, NE quarter top-down, SE quarter bottom-up. Plus an extra copy of the NE quarter shifted 5 m. Plus the reference chip as raw Int8.
  - (b) Index shards for these COGs.
  - (c) A labeled pixel sample: 1,000 train and 1,000 test pixels per region from disjoint chips, Int8 + label. Plus `ref.json` with the mangrove class value, mangrove IoU and accuracy from sklearn `LogisticRegression(max_iter=3000)`, the logreg in mangrove-embed `pixel.py`.
  - (d) The first 256 KiB and the `.vrt` of one real Source Cooperative COG.
- The script also writes `tests/fixtures/aef/NOTICE`. It credits AlphaEarth and states each label source's licence and citation: GMW v3 (CC BY 4.0), ESA WorldCover v200 (CC BY 4.0), GWL_FCS30 (CC BY 4.0), JRC GSW 1.4 (Copernicus, "Source: EC JRC/Google") and GHSL (EC reuse with the source acknowledged). It also states that labels were derived by mangrove-embed's v3 rules.
- CI never touches the network. e2e serves (a) and (b) through a Playwright route that answers Range requests with 206.

## Acceptance criteria
1. `dequantize` maps -127, -1, 0, 1, 127 to sign(q)(q/127.5)^2 within 1e-7, and -128 to NaN.
2. `utmEpsg`: (-180, 10) -> 32601; (180, 10) -> 32660; (3, 0) -> 32631; (3, -0.1) -> 32731; (6, 50) -> 32632.
3. `aoiGrid`: the gt origin and far corner are multiples of 10 m and contain the ring's projected bbox. Rings spanning lon 5.9-6.1, or spanning the equator, give `"zones"`. 2049 px on a side gives `"size"`; 2048 does not.
4. `selectEntries` returns exactly the year's overlapping entries. An entry that only touches an AOI edge is excluded.
5. `aefPreview` maps -0.3 -> 0, 0 -> 128 (`Math.round`), 0.3 and 0.9 -> 255, and NaN to nodata.
6. Bottom-up, real file: from fixture (d), `io/` derives the geotransform and orientation that match the `.vrt`'s north-up GeoTransform, without reading pixel data.
7. Mosaic: an AOI equal to the fixture (a) chip, read through the three mixed-orientation COGs, dequantizes exactly to `dequantize` of the reference chip. Its invalid pixels are NaN. Including the 5 m-shifted COG is refused with a message.
8. Privacy (Playwright request log): requests go only to the app origin and the `AEF_BASE` host, and all are GET. The `AEF_BASE` requests (URL + Range) are identical in a session with 0 polygons and one with 3. No URL, header or body contains a polygon coordinate, a class name or model JSON. After the fetch, training, classification and export make zero requests.
9. From the app origin, only `aef-index/years.json` and `aef-index/{year}/{epsg}.json` are fetched beyond static files.
10. Accuracy: `fit` on the fixture (c) train pixels (64 bands, 11 classes), scored on its test pixels, reaches mangrove IoU and overall accuracy each at least `ref.json` minus 0.02.
11. End-to-end on fixtures (a) and (b): train, classify and export. The output is EPSG:32617 with origin `aoi.gt`, 10 m pixels, and pixels equal to `predictTile` on the cached tiles.
12. A non-206 response, network error or CORS failure shows "Couldn't download embeddings from <host>." The partial cache is discarded and training stays disabled.
13. An AOI/year with no entries shows "No AlphaEarth embeddings here for <year>." and makes no COG requests.
14. With an AEF layer shown, "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind." is visible (e2e).
15. Opening a local fixture (a) COG makes no network requests and yields tiles equal to `dequantize` of its pixels.
16. Index build script (fixture CSV): every row lands in exactly one `{year}/{epsg}.json` shard, and `years.json` lists the years ascending.
