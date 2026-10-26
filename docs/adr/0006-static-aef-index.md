# 0006: Static per-zone AlphaEarth tile index, hosted with the app

**Status:** Accepted (Gage, 2026-10-26)
*Decision amended by Gage on 2026-10-26.*

**Context:** COG file names contain an Earth Engine asset id, so they can't be computed from coordinates, and an index is needed. Google's readme and the Source Cooperative README both describe `aef_index.{parquet,gpkg,csv}` under `v1/annual/`. It has one row per file: WGS84 footprint, CRS, year, UTM zone, and UTM and WGS84 bounds. Footprints never cross the antimeridian (checked 2026-10-26). The live CSV is about 800 MB, and the full shard set is 43 MB over 1,080 shards. Reading GeoParquet in the browser would need a new dependency. Fetching the full index every session wastes bandwidth.

**Decision:** A Node build script with no dependencies (`scripts/`, not shipped) reads the `AEF_BASE` host's `aef_index.csv` and writes `public/aef-index/years.json` and `public/aef-index/{year}/{epsg}.json` (`AefEntry[]`, spec 002). Paths are relative to `AEF_BASE`. Only `years.json` and the shards the tests need are committed; the full set is generated at deploy time with the script. The implementer confirms the CSV column names against the live file.

**Consequences:** No new dependency, and it fits CLAUDE.md ("we host only static files, including a catalog index"). Our host learns only the year and the UTM zone and hemisphere. Index updates are manual. A CC-BY 4.0 attribution goes in `public/aef-index/`. Changing hosts means regenerating the shards.
