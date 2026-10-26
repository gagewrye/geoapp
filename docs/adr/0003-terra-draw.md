# 0003: terra-draw for polygon drawing

**Status:** Proposed

**Context:** MapLibre has no built-in drawing tools. Options considered: (a) terra-draw 1.38.0 with terra-draw-maplibre-gl-adapter 1.5.0. Both are MIT and written in TypeScript. The adapter has no runtime dependencies, and its peer dependencies are `terra-draw ^1` and `maplibre-gl >=4`. `TerraDrawPolygonMode` is exported, and `getSnapshot()` returns GeoJSON features. (b) maplibre-gl-draw, a community fork of mapbox-gl-draw. (c) A hand-rolled click-to-add-vertex tool in `map/`.

**Decision:** Option (a). Drawing and editing are used only in `map/`. `core/` receives plain GeoJSON polygons in lon/lat, so it does not depend on terra-draw.

**Consequences:** Adds two dependencies. Vertex editing and selection come with them, and we don't maintain that code. If we drop terra-draw later, only `map/` changes. Option (c) has no dependency but means we own the editing UX. The choice is recorded as open question 3 in spec 001.
