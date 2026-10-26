# 0010: Painted labels as sparse in-memory tiles, with per-tile overlays

**Status:** Accepted (Gage, 2026-10-26)

**Context:** Painted labels live on the source raster's pixel grid (spec 003). A dense Uint8 label raster for a 20k x 20k image is 400 MB, and CLAUDE.md forbids holding a full raster in memory. Storage options: (a) a sparse in-memory map of 256x256 Uint8 tiles with a cap; (b) OPFS-backed tiles, which are unbounded but make painting async and need more code. For display, a single overlay at preview resolution (at most 1024 px) would hide fine labels on a large raster, since decimation can skip a 1 px dab entirely. maplibre-gl 6.16.0 `src/source/canvas_source.ts`: with `animate: false`, the canvas is re-uploaded only on resize or while playing (`prepare`), and `pause()` runs `prepare` once if playing. Axis-aligned Mercator rectangles are the safe case for image placement (ADR 0002). Saving labels is deferred (Gage, 2026-10-26).

**Decision:** Option (a), with `MAX_LABEL_TILES` = 256 (16 MiB). Each labelled tile gets its own canvas source, warped onto an axis-aligned Mercator grid at tile resolution, and `map/` calls `play()` then `pause()` after each redraw. No label file format is defined.

**Consequences:** No new dependency. Memory stays bounded at about 16 MiB of labels plus up to 256 overlay canvases of about 256 KiB each, plus their GPU textures and up to 256 extra map layers. A dab that would need tile 257 is refused with a message. Labels last only for the session; a save format is chosen when saving is specified. Raising the cap, or moving to OPFS (option b), changes only the store.
