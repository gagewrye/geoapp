# 015: A space backdrop around the globe

**Goal:** Around the globe, show a dark starfield, like Google Maps, using nothing fetched or bundled.

**Status:** Approved (Gage, 2026-10-28). Gage asked: "Add a space backgroun to the globe view similar to what google maps has". He then accepted that the stars stay still. Revised 2026-10-28: stars only, no atmosphere glow. Gage chose option 1, "Drop the glow, stars only (the smallest change; no existing pixel tests need hideSky)". **ADRs:** none. There is no new dependency or asset, and privacy is unchanged (ADRs 0005 and 0014). This spec is independent of specs 013 and 014, so it can be built first or in parallel (see Build order).

**Amended by spec 061 (2026-11-12):** criterion 3 runs at zoom 14 only (`space` 49), and the tester file `space.tester.spec.ts` is deleted. Criterion 2 stays covered by `space` 38. Lost: contrast of text and controls over the stars, and a pitched Mercator horizon.

**Decided (Gage, 2026-10-28):** the stars stay still while the globe turns or zooms; only the globe moves in front of them. Stars that turn with the globe would need a custom WebGL layer. There is no atmosphere glow (see Out).

## What maplibre-gl 6.16.0 does (checked in `node_modules`, `dist/maplibre-gl-dev.mjs`, style-spec 26.4.4)
- **No starfield.** The style's `sky` has only colours and blends: `sky-color`, `horizon-color`, `fog-color`, `fog-ground-blend`, `horizon-fog-blend`, `sky-horizon-blend` and `atmosphere-blend`. All are marked experimental.
- **No sky, no atmosphere.** A style with no `sky` gets `atmosphere-blend` 0 and transparent colours, so nothing is drawn around or over the globe. Main's style has no `sky`.
- **Space today.** Each frame the canvas is cleared to transparent (`Color.transparent`), and the WebGL context has `alpha: true`. So off the globe, the page behind the canvas shows through (now the white body). The `background` layer is drawn only on the globe, so it shows only at the poles beyond ±`MAX_LAT`.

## Scope
**In:** a CSS starfield behind the map canvas.
**Out:**
- **An atmosphere glow.** The implementer measured MapLibre's built-in atmosphere (`atmosphere-blend` 1): it reaches only 1–3 px past the globe's edge, and only on the side its default light faces (left and lower-left). It also tints pixels on the globe. So it can't give an even glow, and it would change the map's own pixels.
- Stars that move with the camera; a sun, or day and night shading; any user control to change or hide the backdrop; any image file.

## Interfaces
No `core/` change.
- `map/style.ts`: `baseStyle()` has no `sky` property, as on main. The branch's `src/map/sky.ts` (`SKY`), its import and wiring, `tests/unit/map/sky.test.ts`, and `hideSky` in `tests/e2e/helpers.ts` are removed. Nothing would use them, and globe pixels are then identical to main's.
- `ui/style.css`: the `#map` rule gets a near-black background (`#03050a`) plus stars made from layered `radial-gradient`s. Use at least three layers with tile sizes that share no common factor (for example 137, 211 and 293 px), so the pattern doesn't look regular. No `url(`.

**Rules.**
- **Where stars show.** Below zoom 12, stars show wherever the globe doesn't cover the view, including during the zoom 11 to 12 morph (ADR 0004). From zoom 12 (Mercator), an unpitched map covers the whole canvas, so no stars show. Above a pitched horizon the canvas is transparent, so the stars show there.
- **Map pixels unchanged.** The stars sit behind the canvas, and the style is as on main, so the WebGL canvas renders exactly as before. `pixelAt` reads that canvas, not the page, so no existing pixel test sees the stars.
- **Privacy.** Gradients are drawn by the browser, so there are no requests, assets or URLs. Spec 012 criterion 5 holds unchanged.
- **Always on.** No control shows, hides or changes the backdrop.

## Build order
Spec 015 touches `map/style.ts` (only to undo the branch's sky wiring), `ui/style.css` and, to remove `hideSky`, `tests/e2e/helpers.ts`. Specs 013 and 014 touch `helpers.ts` (`settled` and `logRequests`) and a comment in `style.css`. The overlaps are small text conflicts, not design conflicts, so the specs can be built in either order or in parallel.

## Acceptance criteria
1. Style (unit, in an existing style test): `baseStyle()` has no `sky` key.
2. Stars (e2e, no file open, zoom 1.5, centre [0, 20]): take a page screenshot of a 120 x 120 px region at the map's bottom-left corner, which is off the globe. Its mean channel value is at most 30, and at least 3 of its pixels have every channel at 160 or more. A region of the same size at the globe's centre has a mean channel value above 30.
3. Mercator (e2e, zooms 12 and 14, unpitched): at 5 screen points spread over the map, `pixelAt` has alpha 255. A page screenshot at each point equals `pixelAt`'s RGB within 2 per channel, so no star shows through.
4. Privacy (e2e request log, plus a unit check of the source): spec 012 criterion 5 passes. The `#map` rule in `src/ui/style.css` contains no `url(`.
5. Existing tests: `npm run check` and the e2e suite pass with no changes to any existing test. No test calls `hideSky`, which no longer exists.
