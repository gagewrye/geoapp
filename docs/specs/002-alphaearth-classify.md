# 002: AlphaEarth embeddings source

**Goal:** Fetch Google AlphaEarth annual embeddings for a user-drawn area and year into a local cache, as training and classification data for spec 004.

**Status:** Approved (Gage, 2026-10-26). **ADRs (Accepted):** 0005 AlphaEarth COGs from Source Cooperative + local AOI cache, 0006 static per-zone index, 0007 Python fixture script, 0008 interim fixtures from public data. Related: 0011, see spec 004.

**Build status (2026-10-26):** Built and tested on this branch: criteria 1–7, 9, 10, 12, 13, 15, 16 and 17, including the per-band Cache rule. Not built: 8, 11 and 14 (UI).

**Decided (Gage, 2026-10-26):**
- Simple regression models only.
- Users fetch embeddings from Source Cooperative behind a configurable `AEF_BASE`, because Google's bucket sends no CORS headers (ADR 0005).
- `MAX_AOI_SIDE` is 2048 px. No basemap in v1.
- CLAUDE.md allows public-dataset fetches that reveal only the area and year.
- AlphaEarth is never hand-labelled, only trained on: labels are painted on local imagery (spec 003) and can train a model on AlphaEarth (spec 004).
- Fixture labels are committed with an attribution NOTICE.
- The preview is on after a fetch, below the imagery.
- Local AlphaEarth files get their own "Open AlphaEarth file" control.
- The file name stays `002-alphaearth-classify.md`.
- Fetch passes of 8 bands, with a single 64-band pass as the fallback for pixel-interleaved COGs.

**Follow-on specs:** 003 paint-brush labels on local imagery. 004 train on AlphaEarth from imagery labels. 005 change detection (per-pixel cosine similarity between years, plus a threshold mask). 006 change prediction (logreg on [E(t-1), E(t)] predicting the class at t+1). AT Protocol: opt-in publishing and discovery of models, label sets and catalog entries under user-owned DIDs; large files are linked off-protocol and private data stays local.

## Scope
In:
- Draw one AOI rectangle with terra-draw `TerraDrawRectangleMode`, and pick a year from the index.
- Download the AOI into an OPFS cache.
- An optional false-colour preview layer, toggled by an "AlphaEarth preview" checkbox: on after a fetch, below any local-imagery preview, view-only (nothing is ever labelled on it).
- Show the dataset's attribution.
- Instead of fetching, open a local AlphaEarth COG (64 bands, Int8, GDAL_NODATA -128) with its own "Open AlphaEarth file" control, through the same dequantizing reader, with no `MAX_AOI_SIDE` limit since nothing is fetched. Its north-up grid is the `Aoi`. Only one set of AlphaEarth data is loaded at a time.

Out: labelling AlphaEarth in any form; training, classifying or exporting on it (spec 004); change detection and change prediction (005, 006); AOIs spanning two UTM zones or hemispheres (blocked with a message); multiple AOIs, Earth Engine, any basemap, showing results on the map, and models other than spec 001 logreg.

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
- **Zone and size.** All AOI rectangle vertices must give the same `utmEpsg`, else `aoiGrid` returns `"zones"` and ui shows "Areas must lie inside one UTM zone and hemisphere." A side over `MAX_AOI_SIDE` returns `"size"` and ui shows "Area too large (max 20 km per side)."
- **Reading COGs.** `io/` derives each COG's geotransform from its own GeoTIFF tags, not geotiff.js `getResolution` (which negates y). Rows of a bottom-up COG (positive y scale, the Source Cooperative layout) are flipped into the north-up AOI grid. A COG whose origin is not a multiple of 10 m from the AOI grid is refused. Pixels covered by no COG are NaN; `Tile.nodata` is null.
- **Cache.** The fetch streams the whole AOI into an OPFS cache, one file per band. Each band file holds the AOI's 64 KiB window planes (256x256 Int8, edge windows padded with -128) in row-major window order, each written once. A window read returns its 64 band planes, dequantized on read. Real Source Cooperative COGs are band-separate (fixture (d)), so the fetch runs in passes of 8 bands and peak memory is bounded by 8 bands' tile row (measured about 35 MB compressed + 32 MiB decoded per COG), each byte fetched once. If any COG in the AOI is pixel-interleaved, the whole fetch runs as one 64-band pass: nothing is refetched, but the bound covers 64 bands. Each 1024 px COG tile is decoded again for every 256 px window; a decoded-tile cache is a possible follow-up. Preview, training and classification read only the cache, so requests depend only on AOI and year.
- **Model.** Spec 001's `Model`, unchanged (`bands` 1..64).
- **Index.** `scripts/build_aef_index.mjs` parses `crs` "EPSG:N" to `epsg` and strips `s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/` from `path`; any other prefix fails the build. The full set is 43 MB, so only `years.json` and the EPSG:32617 shards are committed; deploys generate the rest with the script (ADR 0006).

**Test data (ADR 0007; interim source ADR 0008).**
- Until Gage regenerates them from his chips, the committed fixtures are built by the same script from ADR 0008's stand-in chips: same format, AEF 2021 over the Everglades, labeled by ESA WorldCover 2021 (nearest pixel centre via proj4; 10..100 -> 1..11 in order, mangrove 95 -> 10; WorldCover 0, off-tile and AEF -128 -> 255; train and test chips both contain mangroves). `scripts/fixtures/standin_chips.mjs` writes them as raw Int8/uint8 + `index.csv` and `pack_standin_chips.py` packs `chip_NNNN.npz`, in a directory given as an argument and never committed. The NOTICE then names that source and credits AlphaEarth and ESA WorldCover instead of the label sources below.
- `scripts/fixtures/make_aef_fixtures.py` reads mangrove-embed `data/chips/*/chip_NNNN.npz`: `x` float16 [64,128,128] (invalid pixels all zero), `y` uint8 1..11 with 255 = ignore, 10 m north-up UTM, and `index.csv` `x0,y1` as the upper-left corner. It writes `tests/fixtures/aef/`, at most 5 MB in total:
  - (a) One everglades chip (EPSG:32617), re-quantized to Int8 (all-zero vector -> -128) and split into three COGs: west half bottom-up, NE quarter top-down, SE quarter bottom-up. Plus a copy of the NE quarter shifted 5 m, and the reference chip as raw Int8.
  - (b) Index shards for these COGs.
  - (c) A labeled pixel sample: 1,000 train and 1,000 test pixels per region (stand-ins: the Everglades only) from disjoint chips, Int8 + label. Plus `ref.json` with the mangrove class value, mangrove IoU and accuracy from sklearn `LogisticRegression(max_iter=3000)`, the logreg in mangrove-embed `pixel.py`.
  - (d) The first 256 KiB and the `.vrt` of one real Source Cooperative COG.
- The script also writes `tests/fixtures/aef/NOTICE`, crediting AlphaEarth and stating each label source's licence and citation: GMW v3 (CC BY 4.0), ESA WorldCover v200 (CC BY 4.0), GWL_FCS30 (CC BY 4.0), JRC GSW 1.4 (Copernicus, "Source: EC JRC/Google") and GHSL (EC reuse with the source acknowledged), and that labels were derived by mangrove-embed's v3 rules.
- CI never touches the network. e2e serves (a) and (b) through a Playwright route that answers Range requests with 206.

## Acceptance criteria
1. `dequantize` maps -127, -1, 0, 1, 127 to sign(q)(q/127.5)^2 within 1e-7, and -128 to NaN.
2. `utmEpsg`: (-180, 10) -> 32601; (180, 10) -> 32660; (3, 0) -> 32631; (3, -0.1) -> 32731; (6, 50) -> 32632.
3. `aoiGrid`: the gt origin and far corner are multiples of 10 m and contain the ring's projected bbox. Rings spanning lon 5.9-6.1, or spanning the equator, give `"zones"`. 2049 px on a side gives `"size"`; 2048 does not.
4. `selectEntries` returns exactly the year's overlapping entries. An entry that only touches an AOI edge is excluded.
5. `aefPreview` maps -0.3 -> 0, 0 -> 128 (`Math.round`), 0.3 and 0.9 -> 255, and NaN to nodata.
6. Bottom-up, real file: from fixture (d), `io/` derives the geotransform and orientation that match the `.vrt`'s north-up GeoTransform, without reading pixel data.
7. Mosaic: an AOI equal to the fixture (a) chip, read through the three mixed-orientation COGs, dequantizes exactly to `dequantize` of the reference chip. Its invalid pixels are NaN. Including the 5 m-shifted COG is refused with a message.
8. Privacy (Playwright request log): requests go only to the app origin and the `AEF_BASE` host, and all are GET. For one AOI and year, the `AEF_BASE` requests (URL + Range) are identical in a session with no local raster open and in one with a local raster open. No URL, header or body contains the local raster's file name, a class name or model JSON. After the fetch, showing and hiding the preview make zero requests. (Spec 004 criterion 10 extends this to painted labels.)
9. From the app origin, only `aef-index/years.json` and `aef-index/{year}/{epsg}.json` are fetched beyond static files.
10. Accuracy: `fit` on the fixture (c) train pixels (64 bands, 11 classes), scored on its test pixels, reaches mangrove IoU and overall accuracy each at least `ref.json` minus 0.02.
11. Fetch end-to-end (e2e, fixtures (a) and (b)): drawing the AOI over the chip and picking 2021 fills the cache, and tiles read from it equal `dequantize` of the reference chip. After the fetch, the preview is shown: the canvas pixel at the AOI centre isn't the background colour. Unchecking "AlphaEarth preview" hides it, and checking it again shows it. While AlphaEarth is the only data loaded, Train, Classify and Export stay disabled.
12. A non-206 response, network error or CORS failure shows "Couldn't download embeddings from <host>." The partial cache is discarded and training stays disabled.
13. An AOI/year with no entries shows "No AlphaEarth embeddings here for <year>." and makes no COG requests.
14. Attribution (e2e): while AlphaEarth data is loaded, whether fetched or opened from a file, "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind." is visible, with the preview shown or hidden.
15. Opening a local fixture (a) COG makes no network requests and yields tiles equal to `dequantize` of its pixels.
16. Index build script (fixture CSV): every row lands in exactly one `{year}/{epsg}.json` shard, and `years.json` lists the years ascending.
17. Cache layout (unit, fixture (a) AOI through a fake OPFS): there are 64 band files, each exactly (window count x 64 KiB) bytes. Each window plane is written exactly once. Every window read returns 64 planes equal to the reference chip's.
