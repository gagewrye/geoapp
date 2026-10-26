# 0003: terra-draw for polygon drawing

**Status:** Accepted (Gage, 2026-10-26). Partly superseded by ADR 0009 once accepted: polygon labelling is removed, and terra-draw then draws only spec 002's AOI rectangle (`TerraDrawRectangleMode`).

**Context:** MapLibre has no built-in drawing tools. Options considered: (a) terra-draw 1.38.0 with terra-draw-maplibre-gl-adapter 1.5.0. Both are MIT and written in TypeScript. The adapter has no runtime dependencies, and its peer dependencies are `terra-draw ^1` and `maplibre-gl >=4`. `TerraDrawPolygonMode` is exported, and `getSnapshot()` returns GeoJSON features. A mode's `validation` returns `{ valid, reason? }`, and an invalid result stops the update being stored, including select-mode drags (main, `mutate-feature.behavior.ts`, checked 2026-10-26). (b) maplibre-gl-draw, a community fork of mapbox-gl-draw. (c) A hand-rolled click-to-add-vertex tool in `map/`.

**Decision:** Option (a). Drawing and editing are used only in `map/`. `core/` receives plain GeoJSON polygons in lon/lat, so it does not depend on terra-draw.

**Consequences:** Adds two dependencies. Polygons crossing ±180° are blocked with a message, because terra-draw issues #485 and #971 (open on 2026-10-26) break them; users draw one polygon on each side instead.
