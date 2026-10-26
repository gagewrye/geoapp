# 0004: MapLibre GL JS >= 6.16 with globe projection

**Status:** Accepted (Gage, 2026-10-26)

**Context:** Gage wants a spinnable 3D globe that turns into flat Mercator when zoomed in. MapLibre is in the stack but has no ADR or pinned version. Checked 2026-10-26 against maplibre-gl 6.16.0 (npm latest, BSD-3-Clause). Globe arrived in v5.0.0 ("Support globe mode", plus `GlobeControl`). It is enabled with the style's `projection: { type: "globe" }` or `map.setProjection(...)`. In `src/geo/projection/projection_factory.ts`, `"globe"` means `["interpolate", ["linear"], ["zoom"], 11, "vertical-perspective", 12, "mercator"]`, so the map is a globe below zoom 11 and Mercator from zoom 12. Image sources were misplaced on the globe until 6.5.0 (PR #8172). GeoJSON is tiled in Web Mercator on the globe too, and geojson-vt's `projectY` clamps latitude, so nothing beyond ±85.0511° renders (`@maplibre/geojson-vt` `world-coordinate-helper.ts`, main; maplibre-gl 6.16.0 depends on `^6.3.0`).

**Decision:** Depend on `maplibre-gl` `^6.16.0`, the version checked above. Set the style projection to `"globe"`. Display stays as in ADR 0002 (axis-aligned Mercator image), and drawing follows ADR 0003.

**Consequences:** The globe fixes are recent and the warp mode is marked experimental, so spec 001 criteria 12, 14 and 15 check globe rendering and drawing in e2e. Labels and previews are limited to ±85.0511° (spec 001 `MAX_LAT`); vertices beyond it are blocked, not clamped. Showing the poles would probably need a custom WebGL layer (not investigated).
