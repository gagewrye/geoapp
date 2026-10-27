# Geoplatform

Classify a local GeoTIFF in your browser. Draw labelled polygons, train a logistic regression model, then export a classified GeoTIFF. You can also fetch Google AlphaEarth annual embeddings for an area. Your files, labels and models never leave your device: besides its own static files, the app only fetches AlphaEarth data, and those requests reveal only the area and year.

## Use it
1. **Open GeoTIFF**: pick a GeoTIFF or COG in EPSG:4326, EPSG:3857 or WGS84 UTM (326xx/327xx). A preview of bands 1-3 (or band 1 as greyscale) appears on the globe, which flattens to Mercator from zoom 12. AlphaEarth files are refused here; open them under AlphaEarth embeddings.
2. **Label**: type a class name, click **Draw polygon**, click the vertices, then click the first vertex to close. Use **Edit** to move vertices, drag midpoints, drag or delete polygons. Rename a polygon's class in the list.
3. **Train** on all bands, using every pixel whose centre falls inside a polygon.
4. **Classify and export** streams a single-band Uint8 GeoTIFF. Each pixel is a class index, and 255 means nodata. Chromium opens a Save dialog. Other browsers download the file.
5. **Save model** or **Load model** as JSON. A loaded model must match the open raster's bands.

**AlphaEarth embeddings** (view only for now: training on them comes in a later version):
- **Draw area**, then click two opposite corners. The area must lie in one UTM zone and hemisphere and be at most 20 km (2048 px at 10 m) on a side. An area that isn't is removed, and the earlier area stays. Pick a **Year** and click **Fetch embeddings**. The 64-band embeddings stream from Source Cooperative's copy of the dataset into your browser's private storage (OPFS, about 256 MiB at the largest area), and a false-colour preview appears below any local imagery. An area drawn or a year picked later replaces the loaded data only once fetched; until then the size line says "not fetched yet".
- Or **Open AlphaEarth file**: a local AlphaEarth COG (64 Int8 bands, nodata -128) of any size, read with no network request.
- **AlphaEarth preview** shows or hides it, and the dataset's attribution (CC BY 4.0) shows while it is loaded. Only one set of AlphaEarth data is loaded at a time, and one fetch or file open runs at a time: both controls are disabled until it ends. Fetched embeddings live in one browser tab at a time: while another tab of the app holds them, Fetch says so and changes nothing. AlphaEarth data is never labelled: Train and Classify use local imagery only, so they are disabled while AlphaEarth is in use and no GeoTIFF is open.

v1 limits: polygons can't cross 180° or go past ±85.05° latitude (draw one polygon on each side of 180° instead). EPSG:4326/3857 rasters crossing 180° are refused. Output is capped at 4 GiB (classic TIFF). There are no holes in drawn polygons.

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
