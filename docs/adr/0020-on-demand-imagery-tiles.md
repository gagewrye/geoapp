# 0020: Full-resolution imagery as on-demand raster-aligned tiles

**Status:** Accepted (Gage, 2026-10-29), with spec 020. The cache was raised from 192 to 512 tiles (Gage, 2026-10-29). Amends ADR 0015 (memory).

**Context:** Imagery is one preview of at most 1024 px. Gage needs every source pixel when zoomed in. The options:
- (a) On-demand tiles drawn as ADR 0019 quads.
- (b) A MapLibre raster source fed Mercator tiles through `addProtocol`. This resamples, which is ADR 0016's misalignment, and was not verified on 6.16.0.
- (c) A larger single preview: still not full resolution, and 64 MiB of GPU at 4096².
- (d) A pyramid built in OPFS on open: a full pass and disk writes.

**Decision:** (a). Tiles use overviews or decimation for s ≤ 4, with a fixed 512-tile LRU, not scaled from `navigator.deviceMemory` (Chromium-only). The library facts below were checked in geotiff 3.0.5:
- Its decoded-block cache is unbounded, an array never evicted (`geotiffimage.js:202,421-440`), so it isn't used.
- Its overview rule (`NewSubfileType & 1`, `geotiff.js:328-333`) is reused.
- `Pool` is not used: `worker/create.js` imports `web-worker` and inlines the decoder bundle, and this is unverified with Vite.

**Consequences:**
- No dependency.
- Imagery and label pixels share edges at s = 1.
- Up to 256 MiB more memory, about 500 MiB at worst with reads in flight.
- Without overviews, coarse zooms show the preview.
- More canvas sources: re-check `setWarp` and frame rate on maplibre-gl upgrades.
