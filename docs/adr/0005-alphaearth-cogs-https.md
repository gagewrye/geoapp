# 0005: AlphaEarth embeddings from Source Cooperative COGs, cached locally per AOI

**Status:** Accepted (Gage, 2026-10-26). Shelved by spec 013 (2026-10-28).

**Context:** Gage wants users to fetch the embeddings themselves (spec 002). Checked 2026-10-26:
- **EE catalog** (`GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL`, v1.1): 64 bands at 10 m in local UTM, unit-length vectors, CC-BY 4.0.
- **Google GCS readme:** 8192x8192 Int8 COGs, value = sign(q)(q/127.5)^2, NoData -128, years 2017-2025, folders by year and UTM zone.
- **Google bucket** (`storage.googleapis.com/alphaearth_foundations`): answers Range requests with 206 but sends no `Access-Control-Allow-Origin` (Gage), so a browser can't read it.
- **Source Cooperative copy** (`https://data.source.coop/tge-labs/aef/v1/annual/`, "not officially supported by Google"): the CORS preflight returns 204 with allow-origin, allow-headers and expose-headers all `*`, and ranged GETs return 206 with Content-Range (Gage). Files are about 3.6 GB each, with a `.vrt` alongside. Its README documents a bottom-up layout (positive y scale). AWS Registry lists 2018-2024, while the README says 2017-2025.
- **geotiff 3.0.5** (MIT, already in the stack): reads Int8 data and windows, and `fromUrl` sends Range GETs.

**Decision:** Fetch from Source Cooperative through one constant, `AEF_BASE`. Moving to Google's bucket is a one-line change, once Google enables CORS. Before training, `io/` streams the whole AOI into an OPFS Int8 cache, so the requests never depend on where the labels are.
- **Sent to the host:** IP, user agent, COG paths and byte ranges, which reveal the AOI to about block size and the year.
- **Sent to our host:** the index shard request only (year, UTM zone).
- **Never sent:** labels, polygons, class names or models.

**Consequences:** No new dependency. The host is unofficial and its year coverage may differ from Google's. It needs about 256 MiB of disk per year at the 2048 px cap. Attribution is required. The bottom-up layout is tested against a real file header and its `.vrt` (spec 002 criterion 6).
