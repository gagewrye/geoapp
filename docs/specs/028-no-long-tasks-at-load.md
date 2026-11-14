# 028: No long tasks while imagery loads

**Status:** Approved under Gage's 2026-10-30 perf delegation. **ADR:** 0024. **Builds on specs 025 and 026** (coalesced reads, lattice quads) and on spec 023's background mask reads.

**Amended by spec 073 (2026-11-12):** e2e/unit tests removed by spec 073 (stable or one-off): unit `core/blocks.tester` (criterion 7), `io/rawReader.tester` (1 and 2), `io/imageryLoader.decimate` and `io/imageryLoader.draws` (3), `io/maskCache.task` (3, scope 3) and the `.hold` files (item 2).

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
2. **Smaller decodes elsewhere.** For files that still go through geotiff, the imagery loader's and spec 023's mask-cache reads are split so each decodes at most `TASK_READ_BYTES` = 512 KiB (`rowReads` with that cap). geotiff decodes a whole read in one task, about 8 ms per 256² LZW RGBA tile. Amended under Gage's perf delegation: 4 MiB gave 130 ms tasks on the tiled chunk. Raw reads (item 1) aren't split. The import's imagery reads go through the mask cache (spec 024), so they are capped too. Only label-file reads (`rowBandReader`, `io/labelFile.ts`) keep `MAX_READ_BYTES`.
3. **Yield between draws.**
   - The imagery loader draws ready tiles from a queue, centre first, until 8 ms have passed in the task, then yields with a `MessageChannel` post before drawing more.
   - Mask-cache reads yield the same way between bands, and also within a band once `TASK_BUDGET_MS` (8 ms) has passed. The import yields with `yieldToBrowser` too, not `setTimeout(0)`.
   - A tile drawn after its view went stale is skipped, as today.
4. **Held block bytes (amended under Gage's perf delegation, for spec 024's tiled import target).** Item 2's capped reads would each fetch their own blocks. Instead, `MaskCache.readBand` splits a band's capped reads into groups (`groupReads`), each decoding at most `MAX_READ_BYTES`.
   - Before a group, `source.hold(image, windows, bands)` reads the file bytes of every block those windows decode (`blockIndices`, from the offsets loaded at open). `blobSource.hold` reads them in one call per run of at most `MAX_FETCH`.
   - It then serves the group's fetches from those bytes, and releases them after the group.
   - Raw images (item 1) hold nothing.
   - Peak per group: ≤ 16 MiB of held compressed bytes plus one 512 KiB decode, within ADR 0021's about 48 MiB per read.

**Out of scope:** workers; LZW speed (a single 256² LZW tile decodes in a few ms, well within budget). The 50/60 ms rule covers loading tiles and mask reads, not imports. Known follow-up: the typical (raw) import still has one task of about 342 ms in `previewCells` (`core/maskPreview.ts`).

## Interfaces
- `io/rawReader.ts`:
  - `rawEligible(image): boolean`
  - `rawWindow(image, source, offsets, x0, y0, w, h, samples): Promise<TypedArray[]>`
- `core/raw.ts` (pure): `rowRanges(layout, x0, y0, w, h): { offset: number; length: number }[]` and `copySamples(...)`.
- `core/imagery.ts`: `TASK_READ_BYTES = 512 * 1024`.
- `io/yieldTask.ts`: `yieldToBrowser(): Promise<void>` (a `MessageChannel` post), and `TASK_BUDGET_MS = 8`.
- `io/source.ts`: optional `hold?(image, windows, bands): Promise<() => void>`, which resolves to a release function. `io/blobSource.ts`: `hold(ranges): Promise<() => void>`.
- `core/blocks.ts` (pure): `blockIndices(windows, block, width, height, planes?)` and `groupReads(reads, block, width, height, max): Window[][]`.

## Acceptance criteria
1. **Unit, byte-equal to geotiff `readRasters`:** `rawWindow` on random windows and sample lists, for 1-row and 16-row strips and 256² uncompressed tiles. Formats: uint8 RGBA, uint16 little-endian, float32, overviews, and windows at the right and bottom edges.
2. **Unit:**
   - `rawEligible` is false for LZW, Deflate, Predictor 2, planar 2, 12-bit and big-endian uint16 files, and those decode through geotiff byte-equal to before.
   - `rowRanges` for a 256² window on Chunk 11's layout (147 KB strips, 4 B/px) totals 256 KiB. geotiff decodes 37.8 MB for the same window (256 × 147,664 B).
3. **Unit, fake loader:**
   - Drawing yields after ≤ 8 ms of draws, with a fake clock.
   - No draw happens for a stale view.
   - Imagery and mask reads through geotiff have `decodedBytes` ≤ `TASK_READ_BYTES`.
4. **Real chunks, `run.mjs`, mid-zoom fill:**
   - the longest task ≤ **50 ms** on the typical and Chunk 11 chunks, and ≤ **60 ms** on the tiled chunk (was 171, 52 and 99–143 ms);
   - the last tile ≤ 0.8 s typical, ≤ 0.8 s tiled and ≤ 1.1 s on Chunk 11 (now 0.72, about 0.65 and 1.05 s).
   - Tiled targets amended under Gage's perf delegation: a single LZW decode task can't be split below one read.
5. **Real chunks:** full-resolution zoom reads on Chunk 11 are ≤ 10 MB (was 113 MB for 12 tiles), and full-zoom pan has no task over 50 ms.
6. **Real chunks:** spec 023's background mask reads, run over a mid-zoom view at rest, give no task over 50 ms.
7. **Unit, held bytes:**
   - `blockIndices` lists exactly the blocks the windows decode (brute force over tiles and strips).
   - Each group from `groupReads` decodes ≤ `MAX_READ_BYTES`.
   - Within a hold, a group's reads make no `blob.slice` call beyond the hold's own, and decode byte-equal to unheld reads.
   - After release, fetches read the file again.
   - A raw image's `hold` reads nothing.
8. Spec 020 criteria 4, 6, 8 and 10, spec 022 criteria 3, 4 and 7, and spec 025 criteria 2–4 pass. `npm run check` passes.
