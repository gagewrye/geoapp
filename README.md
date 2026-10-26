# Geoplatform

Classify a local GeoTIFF in your browser. Draw labelled polygons, train a logistic regression model, then export a classified GeoTIFF. Your files never leave your device: the app makes no network requests beyond its own static files.

## Use it
1. **Open GeoTIFF**: pick a GeoTIFF or COG in EPSG:4326, EPSG:3857 or WGS84 UTM (326xx/327xx). A preview of bands 1-3 (or band 1 as greyscale) appears on the globe, which flattens to Mercator from zoom 12. An AlphaEarth embeddings COG (64 Int8 bands, nodata -128) is read as its dequantized float values, with nodata as empty pixels.
2. **Label**: type a class name, click **Draw polygon**, click the vertices, then click the first vertex to close. Use **Edit** to move vertices, drag midpoints, drag or delete polygons. Rename a polygon's class in the list.
3. **Train** on all bands, using every pixel whose centre falls inside a polygon.
4. **Classify and export** streams a single-band Uint8 GeoTIFF. Each pixel is a class index, and 255 means nodata. Chromium opens a Save dialog. Other browsers download the file.
5. **Save model** or **Load model** as JSON. A loaded model must match the open raster's bands.

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
`node scripts/build_aef_index.mjs [csv] [out] [--epsg=N,...]` rebuilds the static AlphaEarth index in `public/aef-index/` (only the EPSG:32617 shards are committed; deploys generate the full set). `scripts/fixtures/` regenerates `tests/fixtures/aef/` (Python with numpy and scikit-learn; see each script's header).
Layout and rules: see `CLAUDE.md`. Features are specified in `docs/specs/` and decisions in `docs/adr/`.
