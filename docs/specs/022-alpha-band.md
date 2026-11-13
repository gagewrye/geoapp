# 022: Honour the TIFF alpha band

**Status:** Approved (Gage, 2026-10-30: "do all"). **ADRs:** none (no dependency; the alpha rule follows GDAL's mask convention). Build after spec 021 merges.

**Amended by spec 061 (2026-11-12):** criterion 6 loses both its e2e tests, `alpha.spec.ts` and `alpha.tester.spec.ts`. The unit `io/alpha` and `core/alpha` tests remain. Lost: the alpha band end to end, and its rendered transparency.

**Amends:**
- Spec 020: reads gain the alpha band.
- Spec 021: the imagery-read skip condition.
- Rule R, below:
  - spec 014 criterion 4's "each imagery window at most once, 256x256" becomes "one row of seed windows per imagery read";
  - spec 021 criterion 5's Cancel stops imagery reads after the current row.

**Goal:** Transparent imagery pixels show as transparent and never take a label.

**Gage's files** (rasterio, 2026-10-30):
- 80 chunks are RGBA uint8: alpha in ExtraSamples, nodata None, 1-row strips, about 24% transparent.
- 6 chunks (Chunk 12 0-2 to 0-7) are uint16 with a band 4 whose colour interpretation is undefined, so they have no ExtraSamples alpha.
  - Their values run 0–256, and about 2.5% of pixels are 256 in every band (their nodata).
  - Gage is converting them to standard RGBA uint8 with a tagged alpha band, so this spec needs no special case for them.

## Decided (Gage, 2026-10-30)
1. **Partial alpha is binary.** Alpha 0 is transparent and nodata; anything above 0 is opaque data. This matches GDAL's alpha mask, which is valid where alpha > 0.
2. **An import's imagery reads are batched by row** (rule R). With alpha, spec 021's skip no longer applies to the 80 RGBA chunks. Without batching, each window's read would decode 256 full-width strips: about 4.5 GB for a 6,572² import, against about 175 MB batched.

## Today (main 99d363a + spec 021)
- **Display:** `warpPreview` and `toRgba` (`core/imagery.ts:162`) draw bands 1–3, and only NaN or nodata gives alpha 0.
- **Masking:** `nodataMask` (paint, `core/nodata.ts:4`) and `maskNodata` (import, the mask's base tiles and export, `core/seed.ts:96`) mask only `nodata` or NaN.
- So transparent areas show their RGB values, usually black. Their black also widens the preview stretch, and they take labels.

## Scope
**Which band is alpha.** `alphaOf(extraSamples, samplesPerPixel)` returns the index of the first ExtraSamples entry that is 1 (associated) or 2 (unassociated), or null. The tag is TIFF 338, loaded eagerly by geotiff 3.0.5 (`globals.js:121,342-346`). Overviews share the index. 0 (unspecified) is not alpha.

**Rule A (Decided 1).** A pixel whose alpha sample is 0 is nodata. Any other alpha value is opaque data. The `nodata` and NaN rules are unchanged.

**Display.**
- The preview and the full-resolution tiles read `[0, 1, 2, alpha]`, or `[0, alpha]` for one band plus alpha.
- Rule A gives texel alpha 0 or 255.
- `warpPreview`'s per-band ranges skip alpha-0 pixels, so the stretch covers only visible pixels.
- Associated alpha's colours are drawn as stored, not un-premultiplied.

**Labels.**
- `nodataMask` and `maskNodata` apply rule A. So painting, import, copy-on-touch and export never label a transparent pixel.
- Labels an old file holds on transparent pixels are masked on import (spec 004's nodata rule).

**Spec 021's skip, amended.**
- `windowLabels` reads the imagery when `nodata !== null`, or the samples are float, or there is an alpha band.
- With alpha only (no nodata, integer samples), it reads just the alpha sample.

**Rule R (Decided 2).**
- An import's imagery reads cover one row of seed windows at a time, through spec 020's `rowReads`, so each read decodes at most `MAX_READ_BYTES`.
- Each window then masks from its row's arrays. One row's arrays are held at a time.
- Copy-on-touch keeps single-window reads.

**Read cost under spec 020.**
- In a chunky file, all samples of a block are decoded whatever `samples` asks for. `Block.bytes` already counts every sample (`getBytesPerPixel` sums them, `geotiffimage.js:288-296`). So the decode bound is unchanged, and output grows by one band but stays within the decoded size.
- In a planar file, the bound already counts the alpha plane.
- The preview's decimated tile gains one Float32 band, 4 MiB at 1024².
- The tile cache is unchanged, since tiles are already RGBA.

**Out of scope:** GDAL internal mask IFDs (`NewSubfileType & 4`), un-premultiplying associated alpha, and alpha in label files (they are single-band).

## Interfaces
- **`core/alpha.ts`:** `alphaOf(extraSamples: number[], samplesPerPixel: number): number | null`.
- **`Tile`** gains `alpha?: number | null`, an index into `bands`. `nodataMask` and `maskNodata` mask `bands[alpha] === 0`.
- **`toRgba(bands, n, ranges, nodata, out, alpha?: number | null)`**, with `alpha` an index into `bands`. `warpPreview` takes the same.
- **`RasterMeta`** gains `alpha: number | null`.
- **`importLabels`** batches its reads by row (rule R). Its signature is unchanged.

## Acceptance criteria
1. **Unit, `alphaOf`:**
   - `([2], 4)` → 3, `([1], 4)` → 3, `([0], 4)` → null, `([], 3)` → null.
   - `([2], 2)` → 1, `([0, 2], 5)` → 4.
2. **Unit, `openGeoTiff`:** an RGBA uint8 fixture with ExtraSamples 2 gives `meta.alpha` 3. A 4-band uint16 fixture with ExtraSamples 0 and nodata 256 gives null, with masking by nodata as before. The existing RGB fixtures give null.
3. **Unit, `toRgba`:** alpha 0 gives `[0, 0, 0, 0]` whatever the RGB. Alpha 1, 128, 255 or 65535 gives alpha 255. Output without alpha is byte-equal to before.
4. **Unit, preview:**
   - On an RGBA fixture whose transparent pixels are RGB 0 and visible pixels 100–200, the transparent pixels' RGBA alpha is 0, and each band's range is [100, 200].
   - The existing fixtures' previews are unchanged.
5. **Unit:** `nodataMask` and `maskNodata` mask alpha 0 and not alpha 1. With no alpha, their results are unchanged.
6. **E2E, RGBA fixture:**
   - A stroke across the transparent edge changes only opaque pixels.
   - An import whose labels cover the transparent area gives effective tiles of 0 there.
   - An export of that import holds 0 there.
7. **Unit, fake source:**
   - Preview and tile reads ask for `[0, 1, 2, 3]` on RGBA, and `[0, 1]` on gray plus alpha.
   - Spec 020 criterion 6 (`decodedBytes` ≤ `MAX_READ_BYTES`) still holds.
8. **Unit, spec 021's skip:**
   - With alpha, no nodata and integer samples, `windowLabels` asks only for the alpha sample, and the tiles are byte-equal to a full read.
   - With no alpha, spec 021 criterion 9 holds.
9. **Unit, rule R, fake source:**
   - Over an import, every imagery read is one row of seed windows (or part of one) with `decodedBytes` ≤ `MAX_READ_BYTES`.
   - Each 1-row strip is decoded at most once per row of seed windows.
   - Effective tiles are byte-equal to unbatched reads.
10. These pass:
    - spec 014 criteria 5 and 9, and criterion 4 with its file-read clauses unchanged and its imagery clause as amended;
    - spec 020 criteria 4 and 10;
    - spec 021 criterion 1, and criterion 5 with no file window read after k+1 and no imagery read after the current row.

    `npm run check` passes.
