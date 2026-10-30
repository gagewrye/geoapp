# 0020: Full-resolution imagery as on-demand raster-aligned tiles

**Status:** Accepted (Gage, 2026-10-29), with spec 020; cache raised to 512 tiles (Gage, 2026-10-29). Amendment A1 (read and block limits 16 MiB, cache counts tiles) awaits Gage's approval. Amends ADR 0015 (memory).

**Context:** Imagery is one preview of at most 1024 px. Gage needs every source pixel when zoomed in. The options were:
- (a) On-demand tiles drawn as ADR 0019 quads.
- (b) Mercator tiles through `addProtocol`. These resample, which is ADR 0016's misalignment, and this wasn't verified on maplibre-gl 6.16.0.
- (c) A larger single preview: still not full resolution, and 64 MiB of GPU at 4096².
- (d) A pyramid written to OPFS on open: a full pass and disk writes.

**Decision:** (a). Tiles come from overviews, or decimation for s ≤ 4. A fixed 512-tile LRU counts tiles, not quads; it isn't scaled from `navigator.deviceMemory`, which is Chromium-only. These geotiff 3.0.5 facts shaped it:
- Its block cache is never evicted (`geotiffimage.js:202,421-440`), so it isn't used.
- It decodes all of a window's blocks at once (`_readRaster`, `Promise.all`), so each read is capped at 16 MiB of decoded blocks, and blocks over 16 MiB turn tiles off.
- `Pool` inlines its decoder through `web-worker` and is unverified with Vite, so it isn't used.

**Consequences:**
- No dependency.
- Imagery and label pixels share edges at s = 1.
- Up to 256 MiB of tiles plus about 96 MiB of reads in flight: about 530 MiB at worst.
- A single-strip file's preview still decodes the whole strip once per 256 px window.
- Without overviews, coarse zooms show the preview.
- Re-check `setWarp` and frame rate on maplibre-gl upgrades.
