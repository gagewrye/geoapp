# 028: No long tasks while imagery loads

**Status:** Approved under Gage's 2026-10-30 perf delegation. **ADR:** 0024. **Builds on specs 025 and 026** (coalesced reads, lattice quads) and on spec 023's background mask reads.

**Goal:** At mid zoom, no main-thread task over 50 ms while tiles load, on all three baseline chunks, with last-tile time no worse than today.

## Evidence (spec 026's measurement, with 025 in)
| | typical | tiled | Chunk 11 |
|---|---|---|---|
| longest mid-zoom task | 171 ms | 99–143 ms | 0–52 ms |
| last tile | 0.72 s | (baseline 0.65 s) | 1.02–1.05 s |

The long task is one `readSamples` call followed by drawing the tiles it fed, all in one task:
- geotiff's `_readRaster` resolves every block with `Promise.all` (`geotiffimage.js:459-530`). Decoding and its per-sample copy loop (`geotiffimage.js:505-530`) run as microtasks, so the browser can't render until the whole read is done.
  - On 1-row strips the read is a 13 MB band, with 60–80 ms in the copy loop.
  - On the tiled chunk most of the time is LZW decoding (`compression/lzw.js:54`).
- The loader then draws about 7 tiles (`toRgba`, `putImageData`, canvas sources) before yielding.

## Scope
1. **Raw window reads for uncompressed files (ADR 0024).** When the image (or overview) has Compression 1, PlanarConfiguration 1, no Predictor, whole-byte samples, and is little-endian or 8-bit:
   - `readSamples` computes each row's byte range for the window's columns from the eagerly loaded offsets (spec 025), and fetches those ranges through `blobSource`. Ranges up to 64 KiB apart merge, as spec 025 does.
   - It copies only the requested samples of the requested columns into typed arrays, one tight loop per row.
   - Strips and uncompressed tiles both qualify. Any other file uses geotiff.
2. **Smaller decodes elsewhere.** For files that still go through geotiff, the imagery loader's and spec 023's mask-cache reads are split so each decodes at most `TASK_READ_BYTES` = 4 MiB (`rowReads` with that cap). The import keeps `MAX_READ_BYTES`.
3. **Yield between draws.**
   - The imagery loader draws ready tiles from a queue, centre first, until 8 ms have passed in the task, then yields with a `MessageChannel` post before drawing more.
   - Mask-cache reads yield the same way between bands.
   - A tile drawn after its view went stale is skipped, as today.

**Out of scope:** workers; LZW speed (a single 256² LZW tile decodes in a few ms, well within budget).

## Interfaces
- `io/rawReader.ts`:
  - `rawEligible(image): boolean`
  - `rawWindow(image, source, offsets, x0, y0, w, h, samples): Promise<TypedArray[]>`
- `core/raw.ts` (pure): `rowRanges(layout, x0, y0, w, h): { offset: number; length: number }[]` and `copySamples(...)`.
- `core/imagery.ts`: `TASK_READ_BYTES = 4 * 2 ** 20`.
- `io/yieldTask.ts`: `yieldToBrowser(): Promise<void>` (a `MessageChannel` post).

## Acceptance criteria
1. **Unit, byte-equal to geotiff `readRasters`:** `rawWindow` on random windows and sample lists, for 1-row and 16-row strips and 256² uncompressed tiles. Formats: uint8 RGBA, uint16 little-endian, float32, overviews, and windows at the right and bottom edges.
2. **Unit:**
   - `rawEligible` is false for LZW, Deflate, Predictor 2, planar 2, 12-bit and big-endian uint16 files, and those decode through geotiff byte-equal to before.
   - `rowRanges` for a 256² window on Chunk 11's layout (147 KB strips, 4 B/px) totals 256 KiB. geotiff decodes 37.6 MB for the same window.
3. **Unit, fake loader:**
   - Drawing yields after ≤ 8 ms of draws, with a fake clock.
   - No draw happens for a stale view.
   - Imagery and mask reads through geotiff have `decodedBytes` ≤ `TASK_READ_BYTES`.
4. **Real chunks, `run.mjs`, mid-zoom fill:**
   - the longest task ≤ **50 ms** on the typical, tiled and Chunk 11 chunks (was 171, 99–143 and 52 ms);
   - the last tile ≤ 0.8 s typical, ≤ 0.72 s tiled and ≤ 1.1 s on Chunk 11 (now 0.72, about 0.65 and 1.05 s).
5. **Real chunks:** full-resolution zoom reads on Chunk 11 are ≤ 10 MB (was 113 MB for 12 tiles), and full-zoom pan has no task over 50 ms.
6. **Real chunks:** spec 023's background mask reads, run over a mid-zoom view at rest, give no task over 50 ms.
7. Spec 020 criteria 4, 6, 8 and 10, spec 022 criteria 3, 4 and 7, and spec 025 criteria 2–4 pass. `npm run check` passes.
