# 020: Full-resolution imagery when zoomed in

**Status:** Approved (Gage, 2026-10-29: "approve all"). The cache was raised to 512 tiles ("yes increase cache"). Amendment A1 (the tester's B1–B3, F1), with the 16 MiB `MAX_BLOCK_BYTES`, was approved (Gage, 2026-10-29: "approve all"). Builds on spec 019. ADR 0020.

**Amended by spec 052 (2026-11-02):** criterion 4's e2e checks run on the rotated UTM grid only (`imagery.tester.spec.ts`), not the 4326 checkerboard. Criterion 8's cap is checked by unit tests only (`map/imagery`); the e2e test checks that opening another raster removes every `imagery-` source.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): e2e `imagery` (criteria 8 and 9) and `imagery.tester` (4); unit `core/imagery.tester`, `io/imageryLoader.tester`, `io/pipeline.preview.tester` (10) and `map/imagery.tester`. The base `core/imagery`, `io/imageryLoader` and `map/imagery` tests stay.

**Request** (Gage, 2026-10-29): "If you are labelling, you want that full resolution when you zoom in to see the details."

**Decided:**
- Without overviews, zooms coarser than 4 source pixels per texel show the preview.
- There is no loading sign.
- Tiles use the preview's stretch.

**Pending, not blocking:** `gdalinfo` for the 1.49 GB file.

**Decided (A1, Gage, 2026-10-29):** `MAX_BLOCK_BYTES` drops from 32 to 16 MiB, which turns full resolution off for files with 16–32 MiB blocks, such as single-strip RGB images of about 2,400² to 3,300² px. The preview still shows, and the message says how to re-save.

## Scope
**Tiles.** A tile is 256x256 texels at scale `s` = 1, 2, 4, …, drawn over the preview and below the mask and labels.
- `s` is the largest power of two not above the source pixels per CSS pixel. It doubles while the view needs more than `IMAGERY_TILES / 2` tiles.
- **Texel sources:**
  - an overview of size W/s x H/s (within 1%);
  - else, for s ≤ 4, full resolution sampled at `i*s + floor(s/2)`;
  - else none, and the preview shows.
  - An overview whose block is over `MAX_BLOCK_BYTES` isn't used, neither for tiles nor as the preview's source. Its level decimates (s ≤ 4) or shows the preview.
- At s ≥ 2 the last texel may reach up to s−1 px past the raster edge, as the preview's decimation does.
- **Placement:** tiles are ADR 0019 quads of the level grid, equal to the label quads at s = 1.

**Loading.**
- After `moveend`, tiles are requested centre first. Reads no longer visible are aborted, and finer tiles draw above coarser ones.
- **A1:** the cache counts tiles, not quads. A tile's quads partition its 256² texels, so it costs 512 KiB however many quads it has.
- At most `IMAGERY_TILES` = 512 tiles (256 MiB). The least recently used tile is evicted whole, all its quads at once.
- Tiles of the view being drawn are never evicted. Opening a raster drops all tiles.

**Reads.**
- Reads use `samples` (bands 0–2, or band 0) and keep raw typed arrays. Two reads at most are in flight.
- **A1:** geotiff 3.0.5 decodes every block a window touches at once (`GeoTIFFImage._readRaster`, `Promise.all`), so reads are bounded by decoded blocks, not by output.
- Each read's touched blocks (full-width strips, or tiles) decode to at most `MAX_READ_BYTES` = 16 MiB. A row's window is split in block-aligned rows and columns as needed.
- Output ≤ decoded, and fetched bytes ≤ decoded unless compression inflates them. So a read peaks at about 48 MiB, and two in flight at about 96 MiB.
- **Large blocks:** a block over `MAX_BLOCK_BYTES` = 16 MiB (A1: was 32) turns tiles off, and the open says: "Full resolution isn't available: this file stores pixels in N MiB blocks (limit 16 MiB). Re-save it tiled, e.g. gdal_translate -of COG."

**Read failures (A1).** A tile read that fails with anything but `AbortError` shows `MESSAGES.imageryUnreadable`, once per opened raster: "Couldn't read part of this file, so some detail may be missing." The tile is asked for again on a later view.

**Preview.**
- **With an overview:** the smallest overview with a side ≥ 1024 is the source.
- **Blocks ≤ `MAX_BLOCK_BYTES`:** reads only the blocks holding a sampled pixel, each cropped to its sampled span and decoded once.
- **A1, larger blocks** (single-strip files): falls back to spec 019's 256 px windows. Output stays small, but each window decodes the whole block. This is the one documented case where memory reaches one decoded block (the whole image for one strip). The block can't be decoded in parts.
- All preview reads use `samples`.

**Out of scope:** worker decoding, a local pyramid, the preview size.

## Interfaces (`core/imagery.ts`, pure)
```ts
export const IMAGERY_TILES = 512, MAX_DECIMATE = 4, MAX_BLOCK_BYTES = 16 * 2 ** 20, MAX_READ_BYTES = 16 * 2 ** 20;
export type Block = { width: number; height: number; bytes: number };   // a TIFF tile or strip, all samples decoded
export function planView(full: Grid, overviews: Overview[], bounds: [number, number, number, number], cssW: number, cssH: number): { level: Level; tiles: Window[] } | null;
export function decodedBytes(w: Window, block: Block, width: number, height: number): number;   // bytes of the blocks w touches
export function rowReads(tiles: Window[], s: number, block: Block, width: number, height: number): Window[];   // A1: was (tiles, s, bytesPerPixel)
export function blockWindows(width: number, height: number, blockW: number, blockH: number, f: number): Window[];
export function toRgba(bands: ArrayLike<number>[], n: number, ranges: [number, number][], nodata: number | null, out: Uint8ClampedArray): void;
```
- `Overview`, `Level`, `RasterSource` (`block`, `overviews`, `readSamples`) and the `imagery-` slot are as before. Layer ids carry the tile key, so tiles can be counted.

## Acceptance criteria
1. **`planView` (unit):**
   - `s` is 1, 1, 1, 2 and 4 at 0.5, 1, 1.9, 2 and 7.9 source pixels per CSS pixel.
   - Tiles are 256-aligned, clipped to the raster and cover the view; a view off the raster gives none.
   - There are never more than `IMAGERY_TILES / 2` tiles.
2. **Levels (unit):**
   - With overviews at 2, 4 and 8, those levels use them.
   - With none: s ≤ 4 samples full resolution, and s = 8 gives `null`.
   - An overview 2% off size is ignored.
3. **Quads (unit):** at s = 1 a tile's quads equal the label overlay's for the same key.
4. **Pixels (e2e, checkerboard, 1 source px ≥ 8 CSS px):**
   - Pixel centres match the source through the stretch, within 1 per channel.
   - Painted edges fall on imagery edges, within 1 device px.
5. **`toRgba` (unit):** matches `warpPreview`'s mapping, with alpha 0 for NaN and nodata.
6. **`rowReads` (unit):**
   - Reads cover the tiles' source pixels.
   - Every read has `decodedBytes` ≤ `MAX_READ_BYTES`, including s = 4 on a 22,300 px wide, 3-band file of 1-row strips (tester case, cc81250).
7. **Cache (unit, fake map):**
   - 600 distinct tiles leave exactly 512 tiles, and the 88 least recently used are gone with all their quads.
   - Every tile of one planned view is still kept after it is drawn, for the 30 m UTM, 7,800 px, 45°N view at 120 m per CSS px (144 tiles, 558 quads; tester case).
8. **Cache (e2e):**
   - Distinct tile keys among `imagery-` layers never exceed 512.
   - Opening another raster removes them all.
9. **Aborts (unit, fake source):** panning away aborts queued reads, and an aborted read draws nothing and shows no message.
10. **Read failures (unit, fake source):**
    - A rejected read, either `Error` or `ProgressEvent`, shows `imageryUnreadable` once, and a second failure shows nothing new.
    - After another open, a failure shows it again.
11. **Large blocks:**
    - Unit: a header with a block over `MAX_BLOCK_BYTES` gives the message and no tiles.
    - E2E: a small single-strip fixture with the limit lowered by a test hook still shows the preview.
12. **Preview (unit):**
    - With a ≥1024 overview, only that overview is read.
    - Otherwise each block is read at most once, with ≤ 3 bands.
    - A single-strip 6,000² RGB file reads 256 px windows, each with output ≤ `MAX_READ_BYTES` (tester case).
    - The existing fixtures' previews are unchanged.
13. `npm run check` passes.

## Estimates (1.49 GB, ~22,300² px, 3 bands, 8-bit; not measured)
- **Memory:** 178 (ADR 0015) + 256 of tiles + 96 of reads in flight is about 530 MiB at worst.
- **Open:** about 1 s with overviews; without them, seconds for 1-row strips.
- **Full-resolution view:** about 0.2–0.5 s tiled, or about 1 s in 1-row strips (16 MiB reads).
- **Gage's file, measured before A1** (6,572² px, RGBA, 1-row strips): 2.15 s to open, 1.7 s to full detail.
