# 0010: Painted labels as sparse in-memory tiles, with per-tile overlays
- **Status:** Accepted (Gage, 2026-10-26); memory amendment approved 2026-10-27 (Gage). Partly superseded by ADR 0013: labels save and load as a label GeoTIFF (spec 004).
- **Context:** Labels live on the source raster's grid (spec 003); a dense Uint8 raster of 20k x 20k is 400 MB, and CLAUDE.md forbids full rasters in memory. Options: (a) capped, sparse in-memory 256x256 Uint8 tiles; (b) OPFS tiles, unbounded but async and more code.
- One overlay at preview resolution (at most 1024 px) can skip a 1 px dab. maplibre-gl 6.16.0 `src/source/canvas_source.ts`: with `animate: false`, a canvas re-uploads only on resize or while playing (`prepare`); `pause()` runs `prepare` once if playing.
- **Decision:** (a), `MAX_LABEL_TILES` = 256 (16 MiB). Each labelled tile gets a canvas source at tile resolution on an axis-aligned Mercator grid (the safe case, ADR 0002); `map/` calls `play()` then `pause()` after each redraw.
- **Consequences:** No new dependency. A dab needing tile 257 is refused. At the cap, memory is about 146 MiB, plus GPU textures and up to 256 map layers:
- 16 MiB of labels and about 2.1 MiB of nodata masks (at most 264 of 8 KiB).
- 64 MiB of overlay canvases and 64 MiB of Int32 overlay indices (256 KiB each per tile). A Uint16 index plus a validity bit would cut indices to about 34 MiB.
- About 162 MiB while a Train runs: its snapshot copies the label tiles, and one Train runs at a time.
- Raising the cap, or moving to OPFS (b), changes only the store.
