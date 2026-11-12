# Geoplatform

Label a local GeoTIFF in your browser. Paint class labels on it with a brush, seed them from an existing class raster, then export them as a label GeoTIFF. Your files and labels never leave your device: the app fetches only its own static files.

## Set up
1. **Install Node.js 22.12 or later** (it includes npm). Get the LTS installer from https://nodejs.org, or:
   - Windows: `winget install OpenJS.NodeJS.LTS`
   - macOS: `brew install node`
   - Linux: use your distribution's packages, or https://nodejs.org/en/download

   Open a new terminal, then check: `node --version`.
2. **Get the code and its packages:**
   ```
   git clone https://github.com/gagewrye/geoapp.git
   cd geoapp
   npm install
   ```
3. **Run it:** `npm run dev`, then open http://localhost:5173 in a Chromium-based browser (Chrome or Edge). Other browsers are untested.

If the page shows "Failed to fetch dynamically imported module", stop the server, run `npm run dev -- --force`, and reload the page.

## Use it
1. **Open GeoTIFF**: pick a GeoTIFF or COG in EPSG:4326, EPSG:3857 or WGS84 UTM (326xx/327xx). Large files might take a minute. Once a raster is open, the top bar holds the file actions, the strip on the left the tools and brush size, and the panel on the right the classes and label display. `\` hides both side columns so the map gets the full width, and `Home` or the ⌂ button under the zoom buttons zooms back to the raster. `?`, or the **?** button at the right of the top bar, lists every shortcut, and each tool button shows its key on hover.
2. **Label** with the brush: choose **Paint**. In **Paint** mode a left drag paints the selected class over any other, and a right drag erases the selected class. Hold `` ` `` (the key left of `1`) to glance at the imagery. **Fill** (`F`, the ▧ button) gives the area under a click the selected class: every connected pixel with the same label, or with none, as far as about 1000 px from the click and never across missing imagery. **Polygon** (`L`, the ⬠ button) fills an outline: click its corners, then press **Enter**, double-click, or click the first corner again. Backspace or a right click removes the last corner, and Escape discards the outline.
3. **Smart select** (`M`, or the ⌖ button) outlines a region for you, with a SAM 2.1 model running on your GPU, in Chromium-based browsers with WebGPU. Click a field, building or other region to preview its mask in the selected class colour; click more to add to it, and Shift+click to exclude a part. The model sees a 1024 x 1024 px window around your first click, in the preview's colours, so a larger object is filled in parts. **Enter** or **✓** applies the mask. Escape or a right click discards the mask.
4. **Import labels** to seed them instead of painting them all, then correct them with the brush: a single-band 8-bit GeoTIFF of class values, resampled onto the imagery by nearest pixel centre. On Chrome and Edge its chooser opens in the imagery's folder. Its classes come from the file's own class table (an **Export labels** file has one, and a `GEOAPP_CLASSES` metadata item written with GDAL or rasterio reads the same way), and "Class v" for each value the table doesn't name. Afterwards, **Apply class map** renames and recolours the imported classes from a JSON matched by file value (`[{ "value": 3, "name": "Water", "colour": "#1f77b4" }, ...]`).
5. **Export labels** saves the labels (your edits over the mask) and class list as a GeoTIFF on the imagery grid (0 = unlabelled).

Labels are kept in this browser as you work, and still never leave your device. They save about 2 s after your last change and when the tab is hidden; the status bar at the bottom shows when they last saved, and the browser asks before you leave with unsaved labels. Open the same file again to be offered them back. An imported mask is copied into the browser's storage too, using about as much disk as the file.

v1 limits: labels beyond ±85.05° latitude are kept and exported but aren't drawn. EPSG:4326/3857 rasters crossing 180° are refused. Output is capped at 4 GiB (classic TIFF).

## Develop
After **Set up**:
```
npm run check        # lint + typecheck + unit tests (Vitest)
npx playwright install chromium
npm run e2e          # builds, serves on :4173, runs Playwright (without the @probe tests)
npm run e2e:changed  # only the e2e files that differ from main, and those that import a changed file
npm run e2e:probe    # the slow flicker probe (spec 045)
```
The full e2e suite runs in CI (GitHub Actions, `.github/workflows/ci.yml`) on every PR to main and every push to it.
Smart select runs SAM 2.1 Hiera Tiny (Meta, Apache-2.0; its licence is in `public/models/sam2.1-hiera-tiny/LICENSE`) with onnxruntime-web (Microsoft, MIT). Its 78 MB of weights come from Hugging Face the first time Smart select is chosen, after a confirm, and stay in the browser's cache (ADR 0035). The tests use a fake model.
`shelf/` holds shelved code that the app doesn't use and `npm run check` doesn't see (ADR 0017; see `shelf/README.md`).
Layout and rules: see `CLAUDE.md`. Features are specified in `docs/specs/` and decisions in `docs/adr/`.
