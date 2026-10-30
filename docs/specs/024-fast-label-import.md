# 024: Label import in one pass over row bands

**Status:** Approved under Gage's 2026-10-30 perf delegation. **ADRs:** none. **Builds on spec 023** (its mask cache and label-file row bands), so it is built after 023 merges.

**Goal:** Importing a label file reads each of its strips once and takes seconds, not minutes.

## Evidence (perf/baseline.md §2, main 57e0493)
- A typical import takes 69.3 s, of which 66.5 s is inside the label file's `read`. It makes 350,196 FileReader calls and reads 2.19 GB for a 42 MB file.
- The 20000² tiled chunk takes about 10 min, and Chunk 11 about 21 min.
- **Cause:**
  - `gather` (`io/maskBase.ts:16`) reads each 256² window with `readRasters`, which on 1-row strips is 256 full-width strips.
  - Each strip is read again for every one of the width/256 windows in its row.
  - Without a class table there is a second full pass (spec 004's pass 1). None of Gage's `labels.tif` files has a table.
- `sourceCells` (`core/seed.ts:12`) projects every pixel even when the file grid is the imagery grid: 0.8–4.6 s.
- Spec 022 adds imagery reads (alpha) to every import, and its rule R reads one span per row. On tiled imagery that span also decodes the tiles between the windows that need imagery (spec 022 review).

## Scope
1. **Row bands.** `gather` takes file cells from spec 023's label-file band cache: decoded 256-row bands of the file, each ≤ `MAX_READ_BYTES`, the last 4 kept.
   - Seed windows are visited row by row. So on an equal grid each file band is read once per import.
   - If a window needs more bands than the cache holds, it still works, just with re-reads.
2. **One pass.** The labelling pass counts raw file values after imagery masking: a 256-entry histogram, plus 256 bits per window recording which values occur. The preview keeps raw values.
   - After the pass, classes come from the histogram (the class map, else the table, else `classesFromValues`) and give the LUT.
   - From the LUT: `count` = Σ hist[v] over v with lut[v] > 0; a window is labelled if any value present in it maps to a class; the preview values are remapped through the LUT.
   - Results are byte-equal to spec 004's two passes. Spec 021's progress total becomes one pass.
3. **Imagery validity from spec 023's mask cache.** The import asks the `MaskCache` for each window's mask, filling missing bands at stroke priority. It no longer reads imagery itself, so spec 022's rule R goes.
   - For tiled imagery, a band read covers only the tiles of the windows it is asked for (`rowReads` gets those windows), which fixes the gap decode.
   - The masks it fills stay cached, so painting right after an import doesn't wait.
4. **Equal-grid fast path.** When both grids share the EPSG, pixel size and rotation, and the file's origin is a whole number of imagery pixels away, `sourceCells` returns cells by offset with no projection.

**Out of scope:** coalescing the FileReader calls (spec 025).

## Interfaces (`core/`)
```ts
export function gridOffset(dst: Grid, src: Grid): [number, number] | null;   // integer pixel offset src - dst, or null
export type RawCounts = { hist: Float64Array; present: Uint8Array };        // present: 32 bytes per seed window
export function finishImport(counts: RawCounts, lut: Uint8Array, previewRaw: Uint8Array): { count: number; labelled: number[]; preview: Uint8Array };
```

## Acceptance criteria
1. **Unit, `gridOffset`:**
   - It gives the offset for shifted equal grids, and null for a different CRS, pixel size, rotation or a sub-pixel shift.
   - With an offset, `sourceCells` equals the projected result, by brute force.
2. **Unit, one pass:** for spec 004's fixtures and random masks, with and without a table or class map:
   - classes, `count`, labelled windows, preview values and effective tiles are byte-equal to the two-pass import;
   - `onProgress` totals equal the window count.
3. **Unit, fake label source:**
   - On 1-row strips with an equal grid, each strip is decoded at most once per import.
   - Every read has `decodedBytes` ≤ `MAX_READ_BYTES`.
4. **Unit, fake imagery:**
   - The import makes no `readWindow` calls; masks come from `MaskCache`.
   - On tiled imagery, the tiles decoded are only those of windows the label file covers.
5. **Real chunks, `run.mjs` (perf/baseline.md Repeat), import:**
   - typical ≤ **8 s** (was 69.3 s), with label-file bytes read ≤ 1.2× its size (was 2.19 GB);
   - the 20000² tiled chunk ≤ **60 s** (was about 10 min);
   - Chunk 11 ≤ **120 s** (was about 21 min).
6. **Paint after import:** on the typical chunk, a 127 px mid-zoom stroke right after the import has p95 latency ≤ 50 ms (was 629 ms).
7. Spec 014 criteria 4, 5, 9 and 14 and spec 021 criteria 1–6 pass, with 021's total as amended here. `npm run check` passes.
