# Geoplatform

Label a local GeoTIFF in your browser. Paint class labels on it with a brush, seed them from an existing class raster, then export them as a label GeoTIFF. Your files and labels never leave your device: the app fetches only its own static files.

## Use it
The globe shows a bundled, low-resolution Natural Earth shaded relief to help you find your way (public domain; `src/map/basemap.NOTICE.md`). It is one static file, the same for every view. The wheel zooms about the centre of the map, a middle-button drag pans, and holding W/A/S/D pans smoothly (not while typing in a field).
1. **Open GeoTIFF**: pick a GeoTIFF or COG in EPSG:4326, EPSG:3857 or WGS84 UTM (326xx/327xx). A preview of bands 1-3 (or band 1 as greyscale) appears on the globe, which flattens to Mercator from zoom 12. Opening another raster discards your labels, after asking.
2. **Label** with the brush. In **Paint** mode a left drag paints the selected class over any other, and a right drag erases the selected class only. The square brush is sized in raster pixels at every zoom (1 to 127, default 7): **−**/**+** or `[`/`]`. Keys `1`-`9` pick a class. **Pan** mode, or holding Space, moves the map with a left drag; the wheel, middle drag, keyboard, zoom buttons and touch always do. A pen's tip paints and its barrel button erases; touch never paints. Add (up to 255), rename and recolour classes in the list. **Undo** or Ctrl+Z (Cmd+Z on macOS) reverts your latest strokes, up to 50 (32 MiB of history); class edits, imports and opening a raster can't be undone. The brush never labels imagery nodata (a pixel where any band is nodata or NaN).
3. **Import labels** to seed them instead of painting them all, then correct them with the brush: a single-band 8-bit GeoTIFF of class values (from another tool, a model run elsewhere, or **Export labels**), resampled onto the imagery by nearest pixel centre. Its classes come from an optional **Class map** JSON (`[{ "value": 3, "name": "Water", "colour": "#1f77b4" }, ...]`; unlisted values stay unlabelled), else the file's own class table, else one "Class v" per value found. The file's GDAL_NODATA value stays unlabelled. The file becomes a mask of any size under your edits: it shows at preview resolution, and a tile you paint or erase is copied from it at full resolution (Undo shows the mask again). Keep the file unchanged on disk while you work; the app reads it again when you edit or export. An import replaces your labels and classes (after asking, if you have any) and then selects **Pan**. Imported labels never land on imagery nodata.
4. **Export labels** saves the labels (your edits over the mask) and class list as a GeoTIFF on the imagery grid (0 = unlabelled), which **Import labels** loads back exactly. Chromium opens a Save dialog. Other browsers download the file.

v1 limits: labels live in memory until you export them. At most 256 tiles of 256 x 256 px hold painted or edited labels; a stroke needing more says so. An imported mask doesn't count towards this. Labels beyond ±85.05° latitude are kept and exported but aren't drawn. EPSG:4326/3857 rasters crossing 180° are refused. Output is capped at 4 GiB (classic TIFF).

## Develop
Requires Node.js 22.12 or later.
```
npm install
npm run dev          # http://localhost:5173
npm run check        # lint + typecheck + unit tests (Vitest)
npx playwright install chromium
npm run e2e          # builds, serves on :4173, runs Playwright
```
`shelf/` holds shelved code that the app doesn't use and `npm run check` doesn't see (ADR 0017; see `shelf/README.md`).
Layout and rules: see `CLAUDE.md`. Features are specified in `docs/specs/` and decisions in `docs/adr/`.
