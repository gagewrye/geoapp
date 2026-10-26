# 0002: proj4 for CRS transforms; warped preview for display

**Status:** Accepted (Gage, 2026-10-26)

**Context:** MapLibre places an image source by four lon/lat corners, on the flat map and on the globe (ADR 0004), but inputs are often in UTM. We need transforms in two directions: raster to Mercator to display the image, and lon/lat to raster to turn drawn polygons into pixels. Options considered: (a) proj4 (npm 2.22.0, MIT; dependencies `mgrs` and `wkt-parser`). (b) Hand-rolled transverse Mercator math. (c) Accept only EPSG:3857/4326 inputs. (d) GDAL-wasm, which is too heavy. Non-rectangular image quads were only fixed in maplibre-gl 6.3.0 (PR #7887), and that PR notes globe raster geometry is subdivided, so projective correction has little effect on the globe; image-source-on-globe placement was fixed in 6.5.0 (PR #8172). Axis-aligned rectangles keep plain affine sampling on every path, so they are the safe case.

**Decision:** Option (a). proj4 is pure JS, so `core/crs` wraps it. v1 supports EPSG:4326, EPSG:3857 and WGS84 UTM (326xx/327xx). The proj strings for these are built locally, with no lookup on epsg.io, because a lookup would leak metadata. For display, a decimated preview is built tile by tile and then warped in `core/` onto an axis-aligned Mercator grid. MapLibre shows it as an image source with rectangular corners, which renders on both the globe and flat Mercator. CRS support is a lookup from EPSG code to a locally built proj string, so adding a CRS means adding one entry plus a fixture.

**Consequences:** Adds one dependency, plus its two transitive dependencies. Other CRSs are rejected with a clear error. The preview is for display only: training and inference run in the raster's own pixel grid, so warping costs no accuracy.
