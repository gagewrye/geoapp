# 0002: proj4 for CRS transforms; warped preview for display

**Status:** Proposed

**Context:** MapLibre renders in Web Mercator, but inputs are often in UTM. We need transforms in two directions: raster to Mercator to display the image, and lon/lat to raster to turn drawn polygons into pixels. Options considered: (a) proj4 (npm 2.22.0, MIT; dependencies `mgrs` and `wkt-parser`). (b) Hand-rolled transverse Mercator math. (c) Accept only EPSG:3857/4326 inputs. (d) GDAL-wasm, which is too heavy. I could not confirm in the MapLibre style spec that an image source draws a non-rectangular quad correctly, so placing the UTM image by its four transformed corners is not relied on.

**Decision:** Option (a). proj4 is pure JS, so `core/crs` wraps it. v1 supports EPSG:4326, EPSG:3857 and WGS84 UTM (326xx/327xx). The proj strings for these are built locally, with no lookup on epsg.io, because a lookup would leak metadata. For display, a decimated preview is built tile by tile and then warped in `core/` onto an axis-aligned Mercator grid. MapLibre shows it as an image source with rectangular corners.

**Consequences:** Adds one dependency, plus its two transitive dependencies. Other CRSs are rejected with a clear error. The preview is for display only: training and inference run in the raster's own pixel grid, so warping costs no accuracy.
