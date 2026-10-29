# 015: A space backdrop around the globe

**Goal:** Around the globe, show a dark starfield with a soft atmosphere glow at the globe's edge, like Google Maps, using nothing fetched or bundled.

**Status:** Draft. Gage asked on 2026-10-28: "Add a space backgroun to the globe view similar to what google maps has". **ADRs:** none. There is no new dependency or asset, and privacy is unchanged (ADRs 0005 and 0014). This spec is independent of specs 013 and 014, so it can be built first or in parallel (see Build order).

**Open question (Gage).** The stars stay still while the globe turns or zooms; only the globe moves in front of them. Stars that turn with the globe would need a custom WebGL layer. Is still acceptable? This spec assumes yes.

## What maplibre-gl 6.16.0 does (checked in `node_modules`, `dist/maplibre-gl-dev.mjs`, style-spec 26.4.4)
- **No starfield.** The style's `sky` has only colours and blends: `sky-color`, `horizon-color`, `fog-color`, `fog-ground-blend`, `horizon-fog-blend`, `sky-horizon-blend` and `atmosphere-blend`. All are marked experimental.
- **Atmosphere glow.** `drawAtmosphere` runs only while the globe renders. Its strength is `atmosphere-blend` times `projectionTransition` times an altitude blend, so it is 0 in Mercator. A style with no `sky` gets `atmosphere-blend` 0 and transparent colours. A style with a `sky` gets `sky-color` `#88C6FC` by default, which would draw blue sky.
- **Space today.** Each frame the canvas is cleared to transparent (`Color.transparent`), and the WebGL context has `alpha: true`. So off the globe, the page behind the canvas shows through (now the white body). The `background` layer is drawn only on the globe, so it shows only at the poles beyond ±`MAX_LAT`.

## Scope
**In:** a CSS starfield behind the map canvas; a native atmosphere glow that fades out before the globe flattens; a test hook to remove the glow; adapting the pixel tests.
**Out:** stars that move with the camera; a sun, or day and night shading; any user control to change or hide the backdrop; any image file.

## Interfaces
No `core/` change.
- New `map/sky.ts` exports `SKY`, and `map/style.ts` adds `sky: SKY` to `baseStyle()`. `SKY` gets its own module because `style.ts` imports a Vite `?url` asset, which Playwright can't load (the reason `helpers.ts` copies `BACKGROUND`).
  ```ts
  export const SKY = { "sky-color": "rgba(0,0,0,0)", "horizon-color": "rgba(0,0,0,0)", "fog-color": "rgba(0,0,0,0)",
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 1, 11, 0] };
  ```
  The colours are transparent so that only the glow draws and the stars stay visible. The blend reaches 0 at zoom 11, before ADR 0004's globe-to-Mercator transition (zoom 11 to 12).
- `ui/style.css`: the `#map` rule gets a near-black background (`#03050a`) plus stars made from layered `radial-gradient`s. Use at least three layers with tile sizes that share no common factor (for example 137, 211 and 293 px), so the pattern doesn't look regular. No `url(`.
- `tests/e2e/helpers.ts`: `hideSky(page)` imports `SKY` from `src/map/sky.ts` and calls `__geoapp.map.setSky({ ...SKY, "atmosphere-blend": 0 })`. Like spec 012's `hideBasemap`, it is test-only.

**Rules.**
- **Transition.**
  - Zoom 9 or below: stars, and the full glow.
  - Zoom 9 to 11: the glow fades out.
  - Zoom 11 to 12 (the projection morph): stars show wherever the globe doesn't cover the view.
  - Zoom 12 and up (Mercator): an unpitched map covers the whole canvas, so no stars show. Above a pitched horizon the sky is transparent, so the stars show there.
- **Privacy.** Gradients are drawn by the browser, and the sky is style data, so there are no requests, assets or URLs. Spec 012 criterion 5 holds unchanged.
- **Always on.** No control shows, hides or changes the backdrop or the glow.
- **Tests that read map pixels below zoom 12** call `hideSky` first, because the glow is alpha-blended in the globe view:
  - `globe.spec`, `basemap.spec`, `brush-hover.spec`, `brush-paint.spec`, `brush-edge.tester.spec` and `brush-gaps.tester.spec`;
  - `aef-file.spec` and `aef-fetch.spec`, until spec 013 shelves them.

  Tests that read pixels only at zoom 12 or above (`brush-180.tester`, `brush-nodata`, `brush-nodata.tester` and `edges`) need no change. The stars never reach `pixelAt`, which reads the WebGL canvas, not the page. The implementer's report lists every test edited.

## Build order
Spec 015 touches `map/style.ts`, the new `map/sky.ts`, `ui/style.css`, `tests/e2e/helpers.ts` and the pixel tests above. Specs 013 and 014 touch two of those files: `helpers.ts` (`settled` and `logRequests`) and a comment in `style.css`. The overlaps are small text conflicts, not design conflicts, so the specs can be built in either order or in parallel. If 015 lands first, its `hideSky` edits to the two aef tests move to `shelf/` with them.

## Acceptance criteria
1. Style (unit): `baseStyle().sky` deep-equals `SKY`, and `SKY`'s three colours have alpha 0.
2. Stars (e2e, no file open, zoom 1.5, centre [0, 20]): take a page screenshot of a 120 x 120 px region at the map's bottom-left corner, which is off the globe. Its mean channel value is at most 30, and at least 3 of its pixels have every channel at 160 or more. A region of the same size at the globe's centre has a mean channel value above 30.
3. Glow (e2e, zoom 1.5): with `hideSky`, scan `pixelAt` rightwards from the globe's centre to the first pixel with alpha 0. Without `hideSky`, the pixel 4 px further out has alpha above 0.
4. Mercator (e2e, zooms 12 and 14, unpitched): at 5 screen points spread over the map, `pixelAt` without `hideSky` equals `pixelAt` with it, within 1 per channel, and every alpha is 255.
5. Privacy (e2e request log, plus a unit check of the source): spec 012 criterion 5 passes. The `#map` rule in `src/ui/style.css` contains no `url(`.
6. Existing tests: `npm run check` and the e2e suite pass, and each test named in Rules calls `hideSky` before reading pixels.
