# Geoplatform

Classify a local GeoTIFF in your browser. Paint labels on it with a brush, train a logistic regression model, then export a classified GeoTIFF. You can also fetch Google AlphaEarth annual embeddings for an area. Your files, labels and models never leave your device: besides its own static files, the app only fetches AlphaEarth data, and those requests reveal only the area and year.

## Use it
1. **Open GeoTIFF**: pick a GeoTIFF or COG in EPSG:4326, EPSG:3857 or WGS84 UTM (326xx/327xx). A preview of bands 1-3 (or band 1 as greyscale) appears on the globe, which flattens to Mercator from zoom 12. AlphaEarth files are refused here; open them under AlphaEarth embeddings. Opening another raster discards your labels, after asking.
2. **Label** with the brush. In **Paint** mode a left drag paints the selected class over any other, and a right drag erases the selected class only. The square brush is sized in raster pixels at every zoom (1 to 127, default 7): **−**/**+** or `[`/`]`. Keys `1`-`9` pick a class. **Pan** mode, or holding Space, moves the map with the mouse; the wheel, keyboard, zoom buttons and touch always do. A pen's tip paints and its barrel button erases; touch never paints. Add (up to 255), rename and recolour classes in the list. The brush never labels imagery nodata (a pixel where any band is nodata or NaN).
   **Seed labels** instead of painting them all, then correct them with the brush:
   - **Import labels**: a single-band 8-bit GeoTIFF of class values (from another tool, a model run elsewhere, or **Export labels**), resampled onto the imagery by nearest pixel centre. Its classes come from an optional **Class map** JSON (`[{ "value": 3, "name": "Water", "colour": "#1f77b4" }, ...]`; unlisted values stay unlabelled), else the file's own class table, else one "Class v" per value found. The file's GDAL_NODATA value stays unlabelled.
   - **Seed from model**: label every pixel the current model predicts with at least **Min. confidence** (0 to 1).
   - While labels exist, **Seed mode** picks **Merge** (fill only unlabelled pixels, adding new class names) or **Replace** (after asking). Seeds never land on imagery nodata.
   - **Export labels** saves the labels and class list as a GeoTIFF on the imagery grid (0 = unlabelled), which **Import labels** loads back exactly.
3. **Train** on all bands, using every labelled pixel; at least two classes need labels.
4. **Classify and export** streams a single-band Uint8 GeoTIFF. Each pixel is a class index, and 255 means nodata. Chromium opens a Save dialog. Other browsers download the file.
5. **Save model** or **Load model** as JSON. A loaded model must match the open raster's bands.

**AlphaEarth embeddings** (view only for now: training on them comes in a later version):
- **Draw area**, then click two opposite corners (the brush switches to Pan; click **Paint** to label again). The area must lie in one UTM zone and hemisphere and be at most 20 km (2048 px at 10 m) on a side. An area that isn't is removed, and the earlier area stays. Pick a **Year** and click **Fetch embeddings**. The 64-band embeddings stream from Source Cooperative's copy of the dataset into your browser's private storage (OPFS, about 256 MiB at the largest area), and a false-colour preview appears below any local imagery. An area drawn or a year picked later replaces the loaded data only once fetched; until then the size line says "not fetched yet".
- Or **Open AlphaEarth file**: a local AlphaEarth COG (64 Int8 bands, nodata -128) of any size, read with no network request.
- **AlphaEarth preview** shows or hides it, and the dataset's attribution (CC BY 4.0) shows while it is loaded. Only one set of AlphaEarth data is loaded at a time, and one fetch or file open runs at a time: both controls are disabled until it ends. Fetched embeddings live in one browser tab at a time: while another tab of the app holds them, Fetch says so and changes nothing. AlphaEarth data is never labelled: Train and Classify use local imagery only, so they are disabled while AlphaEarth is in use and no GeoTIFF is open.

v1 limits: labels live in memory until you export them. At most 256 tiles of 256 x 256 px hold labels; a stroke or seed needing more says so. There's no undo. Labels beyond ±85.05° latitude train but aren't drawn. EPSG:4326/3857 rasters crossing 180° are refused. Output is capped at 4 GiB (classic TIFF).

## Develop
Requires Node.js 22.12 or later.
```
npm install
npm run dev          # http://localhost:5173
npm run check        # lint + typecheck + unit tests (Vitest)
npx playwright install chromium
npm run e2e          # builds, serves on :4173, runs Playwright
```
`node scripts/build_aef_index.mjs [csv] [out] [--epsg=N,...]` rebuilds the static AlphaEarth index in `public/aef-index/`, replacing it only when the whole CSV parses and has data rows (only the EPSG:32617 shards are committed; deploys generate the full set). `scripts/fixtures/` regenerates `tests/fixtures/aef/` (Python with numpy and scikit-learn; see each script's header).
Layout and rules: see `CLAUDE.md`. Features are specified in `docs/specs/` and decisions in `docs/adr/`.
