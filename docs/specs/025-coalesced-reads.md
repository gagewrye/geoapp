# 025: One file read per run of adjacent blocks

**Status:** Approved under Gage's 2026-10-30 perf delegation. **ADR:** 0022. Independent of 023; it touches only `io/geotiffSource.ts`, `io/labelFile.ts`, a new `io/blobSource.ts` and the preview's read loop in `io/pipeline.ts`.

**Goal:** Cut the fixed cost of every strip or tile read, which is the largest remaining cost in open, zoom and every read-heavy path.

## Evidence (perf/baseline.md §1, §3)
- geotiff 3.0.5 reads every block through `FileReaderSource.fetchSlice` (`source/filereader.js:17-26`): one `Blob.slice` plus a FileReader each, at about 100 µs of synchronous IPC per call.
- `Blob.slice` is the top or second self-time function in every read-heavy phase.
- **Mid-zoom fill:** 2.80 s with 7,022 reads (typical) and 3.37 s with 7,554 reads (Chunk 11), against 0.65 s with 105 reads on the tiled COG.
- **Open:** each sampled strip costs 3 serial reads (typical: 2,788 reads, 2.74 s). `StripOffsets` and `StripByteCounts` are `DeferredArray`s loaded one index at a time (`geotiffimage.js:408-409`, `imagefiledirectory.js:200-215`).

## Scope
1. **Coalescing source (ADR 0022).**
   - `blobSource(blob)` implements geotiff's source contract: `fetch(slices, signal): Promise<ArrayBuffer[]>`, used through the exported `GeoTIFF.fromSource` (`geotiff.js:529`).
   - It collects the `fetch` calls made before the next macrotask.
   - It sorts them and merges ranges whose gap is ≤ `MERGE_GAP` = 64 KiB, up to `MAX_FETCH` = 16 MiB per run. A slice larger than that is fetched alone.
   - It reads each run with one `blob.slice(a, b).arrayBuffer()` and hands out sub-ranges, with no cache.
   - Ranges past the end of the file are clamped; the header fetch asks for 1,024 bytes.
   - An abort rejects only its own callers.
   - Both the imagery and the label file use it.
2. **Eager block offsets.** At open, `loadValue` is called for `StripOffsets` and `StripByteCounts` (or `TileOffsets` and `TileByteCounts`) on image 0 and on every overview used. `loadAll` marks every index loaded, so later `loadValueIndexed` calls read nothing.
   - Cost: 16 bytes per block (257 KB for Chunk 11).
3. **Preview reads in parallel.** The preview keeps up to 4 reads in flight when each read's `decodedBytes` is ≤ 4 MiB, and 1 otherwise. Progress still counts finished reads, and a stale open still stops at the next read.

**Out of scope:** reading only a window's columns from uncompressed strips (re-measure after this spec), and workers.

## Interfaces
```ts
// io/blobSource.ts
export const MERGE_GAP = 64 * 1024, MAX_FETCH = 16 * 2 ** 20;
export function blobSource(blob: Blob): { fetch(slices: { offset: number; length: number }[], signal?: AbortSignal): Promise<ArrayBuffer[]>; fileSize: number };
// core/ranges.ts (pure)
export function mergeRanges(r: { offset: number; length: number }[], gap: number, max: number): { offset: number; length: number; members: number[] }[];
```

## Acceptance criteria
1. **Unit, `mergeRanges`:**
   - Merged runs cover every input and none passes `max`, unless a single input does.
   - Runs never bridge a gap over `gap`.
   - Inputs are returned by index.
2. **Unit, `blobSource` over a `Blob`:**
   - Bytes are equal to `blob.slice` for random slices.
   - 256 adjacent strip fetches made in one task cause 1 `slice` call.
   - The end of the file is clamped.
   - An aborted signal rejects its fetch and leaves the others intact.
3. **Unit:** after open, reading any window makes no reads of `StripOffsets` or `StripByteCounts`.
4. **Unit:** existing fixtures decode byte-equal through `blobSource` and through `fromBlob`, for both imagery and label files.
5. **Real chunks, `run.mjs`:**
   - Typical open ≤ **1.3 s** to preview (was 2.74 s), with FileReader or `slice` calls ≤ sampled strips + 20 (was 2,788).
   - Mid-zoom last tile ≤ **1.3 s** typical (was 2.80 s) and ≤ **1.6 s** Chunk 11 (was 3.37 s).
   - Calls per mid-zoom fill ≤ 200 (was about 7,000).
   - The tiled chunk's open and fills are no slower than baseline +10%.
6. Spec 019 criteria 1–5 and spec 020 criteria 6, 10 and 12 pass. `npm run check` passes.
