# 020: Full-resolution imagery when zoomed in

Status: Approved (Gage, 2026-10-29: "approve all"). Builds on spec 019. ADR 0020.

The request (Gage, 2026-10-29): "It also displays as much lower resolution than the source image. If you are labelling, you want that full resolution when you zoom in to see the details."

## Pending (not blocking)
- `gdalinfo` for the 1.49 GB file (tiled or striped, block size, compression, overviews). The estimates below stay unmeasured until it arrives.

## Decided (Gage, 2026-10-29)
1. In a file without overviews, zooms coarser than 4 source pixels per texel show the 1024 px preview. `gdaladdo` or `gdal_translate -of COG` adds overviews. A local pyramid is a later option.
2. There is no loading sign for tiles. The preview stays drawn underneath.
3. Tiles use the preview's per-band stretch, so colours match at every zoom.

## Scope
**Imagery tiles.** For the current view, draw imagery tiles over the preview, below the mask and labels.
- A tile is 256x256 texels at scale `s` (1, 2, 4, …). One texel stands for s x s source pixels.
- `s` is the largest power of two not above the source pixels per CSS pixel. If that would need more than `IMAGERY_TILES / 2` tiles, `s` doubles until it doesn't.
- **Where texels come from:**
  - an overview whose size is W/s and H/s, within 1%;
  - otherwise, when s ≤ 4, full resolution sampled at `i*s + floor(s/2)`, as `decimateInto` does;
  - otherwise, nothing: the preview alone shows.
- **Placement:** each tile is drawn as ADR 0019 quads of its level's grid. At s = 1 these are exactly the label tile's quads, so imagery and label pixels share edges.
- **Loading:**
  - After `moveend`, visible tiles are requested centre first. Reads no longer visible are aborted.
  - Finer tiles draw above coarser ones.
  - At most `IMAGERY_TILES` = 192 tiles are kept, least recently used first out (96 MiB: 48 of canvas, 48 of GPU).
  - Opening a raster drops them all.
- **Reads:**
  - Reads use geotiff's `samples` option (bands 0–2, or band 0 alone) and keep the raw typed arrays (no Float32 copy).
  - Visible tiles in one row are read as one window. Each read is at most 32 MiB raw, splitting a row's window if needed.
  - Tiles are placed by `tileQuads`.
- **Large blocks:** if a TIFF block (a tile, or a strip of width x RowsPerStrip) is over `MAX_BLOCK_BYTES` = 32 MiB, imagery tiles are off and the open says: "Full resolution isn't available: this file stores pixels in N MiB blocks (limit 32 MiB). Re-save it tiled, e.g. gdal_translate -of COG." This catches single-strip files.

**Faster preview (folds in spec 019's speedups).**
- If an overview has a longest side ≥ 1024, the smallest such overview is the preview's source.
- Otherwise, the preview reads only the TIFF blocks that hold a sampled pixel, each cropped to its sampled span and each decoded once.
- Both use `samples`. Spec 019's bar counts these reads.

**Out of scope:** worker decoding (ADR 0020); a local pyramid; changing the 1024 px preview size.

## Interfaces (`core/imagery.ts`, pure)
```ts
export const IMAGERY_TILES = 192, MAX_DECIMATE = 4, MAX_BLOCK_BYTES = 32 * 2 ** 20, MAX_READ_BYTES = 32 * 2 ** 20;
export type Overview = { index: number; width: number; height: number };
export type Level = { s: number; grid: Grid; overview: number | null };   // null: sample full resolution
export function planView(full: Grid, overviews: Overview[], bounds: [number, number, number, number], cssW: number, cssH: number): { level: Level; tiles: Window[] } | null;
export function rowReads(tiles: Window[], s: number, bytesPerPixel: number): Window[];   // source windows, each ≤ MAX_READ_BYTES
export function blockWindows(width: number, height: number, blockW: number, blockH: number, f: number): Window[];
export function toRgba(bands: ArrayLike<number>[], n: number, ranges: [number, number][], nodata: number | null, out: Uint8ClampedArray): void;
```
- `warpPreview` also returns `ranges`. `decimateInto` accepts `ArrayLike<number>` bands.
- `RasterSource` (`io/source.ts`) gains:
  - `block: { width; height; bytes }`
  - `overviews: Overview[]`, which are IFDs with `NewSubfileType & 1`, not `& 4`, and the same bands
  - `readSamples(image, x0, y0, w, h, bands, signal?)`
- `map/imagery.ts` adds the `imagery-` layer slot between `preview` and `mask`.

## Acceptance criteria
1. **Unit, `planView`:**
   - At 0.5, 1, 1.9, 2 and 7.9 source pixels per CSS pixel, `s` is 1, 1, 1, 2 and 4.
   - Tiles are 256-aligned in the level grid, clipped to the raster, and cover the view.
   - A view off the raster gives no tiles.
   - Never more than `IMAGERY_TILES / 2` tiles.
2. **Unit, level choice:**
   - With overviews at 2, 4 and 8, those levels use them.
   - With none: s ≤ 4 samples full resolution, and s = 8 gives `null`.
   - An overview 2% off size is ignored.
3. **Unit:** at s = 1, a tile's quads equal the label overlay's quads for the same key.
4. **E2E (checkerboard fixture, 1 source pixel ≥ 8 CSS pixels):**
   - Screen samples at pixel centres match the source through the preview stretch, within 1 per channel.
   - A painted pixel's colour edges fall on imagery edges, within 1 device pixel.
5. **Unit, `toRgba`:** matches `warpPreview`'s mapping, and gives alpha 0 for NaN and nodata.
6. **Unit, `rowReads`:** each read ≤ `MAX_READ_BYTES`, and their union covers the tiles' source pixels.
7. **E2E:** after zooming across the raster, there are never more than `IMAGERY_TILES` `imagery-` sources. Opening another raster removes them all.
8. **Unit, fake source:** panning away aborts queued reads, and an aborted read draws nothing.
9. **Unit and E2E:**
   - A header with a block over `MAX_BLOCK_BYTES` shows the message, adds no `imagery-` layer, and still shows the preview.
   - The E2E test uses a small single-strip fixture with the limit lowered through a test hook.
10. **Unit, preview:**
    - With a ≥1024 overview, only that overview is read.
    - Without one, each block is read at most once, and `samples` has ≤ 3 bands.
    - The existing fixtures' previews are unchanged.
11. `npm run check` passes.

## Estimates for the 1.49 GB file (assumed ~22,300² px, 3 bands, 8-bit; not measured)
- **Memory:** up to 96 MiB of tiles plus at most 2 x 32 MiB of reads in flight, on top of ADR 0015's 178 MiB. That is about 350 MiB at worst.
- **Open:** about 1 s with overviews. Without them:
  - a striped file reads about 1/22 of its strips (seconds);
  - a tiled file still decodes every block once.
- **Zoom to full resolution:** a 1920x1080 view is about 6 MB of source, so about 0.2–0.5 s tiled. A striped file decodes whole strips (about 70 MB here), so about 1 s.
