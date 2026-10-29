# 012: Default low-resolution earth basemap

**Goal:** Show a low-resolution shaded-relief earth on the globe at all times, only to orient the user, without revealing the viewed area to anyone.

**Status:** Approved (Gage, 2026-10-27: bundled Natural Earth shaded relief, low resolution, bottom layer, not hideable by users). **ADRs:** 0014 bundled basemap (Accepted). Partly shelved by spec 013 (2026-10-28), lapsed: AlphaEarth layers and controls.

## Scope
In: one bundled Web Mercator image as the bottom map layer, always shown; its provenance file; adapting existing pixel tests.
Out: vector or labelled basemaps, borders, place names; fetched tiles; higher resolutions; anything beyond ±`MAX_LAT` (ADR 0004); any user control to hide, dim or swap it.

## Interfaces
No `core/` change. `src/map/basemap.jpg` (imported with Vite `?url`, so it is served under `assets/`), `src/map/basemap.NOTICE.md`. `map/style.ts` `baseStyle()` gains an image source `basemap` with that URL and coordinates `[[-180, MAX_LAT], [180, MAX_LAT], [180, -MAX_LAT], [-180, -MAX_LAT]]`, and a raster layer `basemap` directly above `background`. `map/layers.ts` `SLOTS` starts with `"basemap"`.

**Rules.**
- **Image.** 2048x2048 baseline JPEG, at most 1 MiB, EPSG:3857 over ±20037508.34 m both ways, made from Natural Earth `NE1_50M_SR_W` 3.2.0 (public domain) by `gdalwarp -s_srs EPSG:4326 -t_srs EPSG:3857 -te -20037508.34 -20037508.34 20037508.34 20037508.34 -ts 2048 2048 -r average`, then `gdal_translate -of JPEG -co QUALITY=85`. The NOTICE gives the source URL, version, licence and these commands. GDAL is a hand-run dev tool, not a dependency (as ADR 0007's Python).
- **Rendering.** MapLibre's image source maps corners linearly in Mercator, which is why the file must be Web Mercator (maplibre-gl 6.16.0 `image_source.ts`; a whole-world image becomes tile 0/0/0 and wraps). The layer uses default linear resampling and opacity 1. It is the bottom map layer: only the plain `background` colour, which fills the poles beyond ±`MAX_LAT` and is not imagery, lies under it. Layers bottom to top: background, basemap, then spec 003's order (AlphaEarth preview, imagery preview, label overlays, hover), then terra-draw.
- **Privacy.** The image is one static asset of the app, requested once per page load at the same URL whatever the view, so it reveals nothing about the area (spec 001 criterion 1 allows the app's own static files). Panning and zooming make no requests.
- **Always shown.** No control in the UI shows, hides, dims or replaces the basemap, and no `ui/` or `map/` code changes its visibility or opacity after the style loads; opening, closing or toggling anything else leaves it visible.
- **Tests.** Tests that compare map pixels with `BACKGROUND` first hide the basemap through the existing e2e hook, which is test-only and not user-facing (`__geoapp.map.setLayoutProperty("basemap", "visibility", "none")`): today `tests/e2e/globe.spec.ts`, `aef-file.spec.ts` and `aef-fetch.spec.ts`. Layer-order tests (`aef-file.spec.ts`, `aef-preview.tester.spec.ts`, `brush-edge.tester.spec.ts`) accept `basemap` second.

## Acceptance criteria
1. Asset (unit, Node): `src/map/basemap.jpg` is a JPEG of 2048x2048 (read from its SOF marker) and at most 1 MiB; the NOTICE names `NE1_50M_SR_W`, version 3.2.0, public domain and both commands.
2. Shown at startup (e2e): with no file opened, at zoom 1.5, the rendered pixel at lon 13, lat 23 (Sahara) and at lon -150, lat 0 (Pacific) is not `BACKGROUND` (more than 3 per channel apart), and the two differ by more than 30 in some channel.
3. Placement (e2e, zoom 3 globe and zoom 12 Mercator): at 8 points the test picks where the asset is uniform within 4 px (within 10 per channel), the rendered pixel at the point's screen position matches the asset's pixel at ((lon + 180) / 360 x 2048, (1 - mercY(lat) / π) / 2 x 2048) within 12 per channel.
4. Order (e2e): `getStyle().layers` ids start `background`, `basemap`; after opening the RGB fixture and painting, the imagery preview and a label overlay come after `basemap`. At a valid imagery point the rendered pixel is the same with the basemap visible and hidden (the preview is opaque over it).
5. Privacy (request log, e2e): from page load, exactly one request ends in the basemap's file name, it is under `${base}assets/`, and its URL is identical in two sessions that jump to different places. Panning and zooming across zoom 1 to 14 after load make no requests.
6. Not hideable (e2e): the page has no control whose label or id mentions the basemap. After opening the RGB fixture, painting, switching Paint/Pan, toggling the AlphaEarth preview, using the area tool and opening another raster, `getLayoutProperty("basemap", "visibility")` is not `"none"`, its `raster-opacity` is 1 or unset (default 1), and it is still second in the layer list.
7. Existing tests: `npm run check` and the e2e suite pass, with the pixel tests named in Rules hiding the basemap through the hook.
