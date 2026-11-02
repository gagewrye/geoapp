# 023: Paint without lag

**Status:** Approved (Gage, 2026-10-30: "apply fixes. optimize for smoothness over storage"). **ADR:** 0021 (Accepted). Written against main 99d363a plus specs 021 and 022. Amended by spec 048 (2026-11-01): there is no tile cap (ADR 0033), so Decided 2, F6's cap bullet and criterion 2's cap clause lapse; `brushSpans` always applies.

**Request** (Gage, 2026-10-30): "The paint tool has a lot of lag that makes it difficult to use." His imagery: chunks of 6,500 to 11,000 px, RGBA uint8, 1-row strips, uncompressed, with tagged alpha.

## Decided (Gage, 2026-10-30)
1. Every valid mask is read in the background after open, so painting never waits. This must not starve the visible imagery tiles (F3).
2. At the 256-tile cap, a pointer move applies whole or not at all.
3. Wherever a cap trades smoothness for memory, smoothness wins. The worst case is stated below.

**Pending, not blocking:** where Gage feels the lag. The ranking below is estimated from the code, and a trace from his browser may follow.

## Where the time goes (from the code; estimates, not measured)
1. **Nodata-mask reads (the main cause).** `PaintQueue.run` (`io/paintQueue.ts:92-109`) does a 256² `readWindow` for each new key a cell touches, and every later cell waits behind it.
   - On 1-row strips one read decodes 256 full-width strips: 6.7 MB at 6,572 px wide, 11 MB at 11,000. That is 256 separate file reads, 97% of them discarded.
   - All 4 bands are then converted to Float32. Estimated 100–300 ms per window, and up to 4 at a tile corner.
   - `keepMasks` (`core/labelStore.ts:83`) drops the masks of unstored windows, so those windows are read again on every visit.
2. **Copy-on-touch** (spec 014): `baseTile` re-reads the imagery, plus 256 label-file strips per window.
3. **New-tile hitch:** `tileQuads` (ADR 0019) runs about 66,000 projections, estimated 30–130 ms on UTM. The new sources and layers also force a 1024² mask repaint.
4. **Stamping:** every Bresenham step (`map/brush.ts:88`) is a full s² stamp, about 1.6 M writes per 100 px move at s = 127, plus a per-cell undo record, `keepMasks` and DOM syncs.
5. **Not causes:** redraws (already once per frame, about 1–3 ms per tile), undo copies, and the hover.

## Scope
**F1. Valid-mask cache (ADR 0021).**
- Each 256² window's mask is kept for the raster's life: `"all"` or `"none"` with no array when uniform, else 8 KiB of bits.
- There is no window cap: an 11,000² chunk needs at most 15 MiB (1 bit per pixel).
- Above `MASK_BYTES` = 256 MiB of arrays (about 2.1 Gpx of mixed windows), the least recently used are dropped first.
- `keepMasks` no longer drops masks.

**F2. Row reads.** A missing mask reads its 256-row band through spec 020's `rowReads` (each read decodes at most `MAX_READ_BYTES`) and fills every window in the band. Bands requested (spec 022):
- no nodata, integer samples and no alpha: no read (`"all"`);
- alpha only: the alpha sample;
- else: all bands.

**F3. Read order.** There is one mask read at a time, chosen in this order:
1. masks a queued stroke cell waits on;
2. the bands under and next to the Paint hover footprint;
3. background bands, from the view's centre band outwards.
- Background reads start only after "Raster opened.", and only while spec 020's loader has no read queued or in flight. Between reads they yield to a macrotask.
- They pause during an import, and stop when another raster opens.
- Background reads read the whole raster once: about 173 MB at 6,572², 484 MB at 11,000².

**F4. Base tiles** use the cached mask, not an imagery read. The label file keeps its last 4 decoded row bands (each ≤ `MAX_READ_BYTES`, least recently used dropped first).

**F5. Quads ahead of time.** While hovering in Paint, quads are computed in idle callbacks for the 5x5 tiles around the footprint. `LabelOverlays` keeps every computed quad set for the raster's life (corners only, under 1 KiB per tile).

**F6. Swept stamping.**
- One `PaintOp` per pointer move covers the union of that move's footprints as row spans, about L·s writes instead of L·s².
- One undo record, one `applied` and one `onChange` per move.
- At the cap, a move applies whole or not at all.

**Worst-case memory:**
- spec 020's about 530 MiB;
- plus masks: 256 MiB at most, 15 MiB for Gage's largest chunk;
- plus one mask read: 48 MiB;
- plus label rows: 64 MiB.

That is about **900 MiB** at worst, and about **660 MiB** on Gage's chunks.

**Out of scope:** workers; reading masks during the preview pass.

## Interfaces (`core/`)
```ts
export const MASK_BYTES = 256 * 2 ** 20;
export type ValidMask = Uint8Array | "all" | "none";        // bits as nodataMask: 1 = nodata
export function compactMask(bits: Uint8Array, n: number): ValidMask;
export type Span = { row: number; x0: number; x1: number }; // x1 exclusive
export function sweptSpans(cells: [number, number][], side: number, dims: { width: number; height: number }): Span[];
export function brushSpans(store: LabelStore, masks: Map<string, ValidMask>, spans: Span[], value: number, erase: boolean): "ok" | "full";
export function bandOrder(bands: number, centre: number): number[];   // centre first, then alternately below and above
```
- `PaintOp` becomes `{ spans; box: Window; value; erase; stroke? }`.
- `io/maskCache.ts` provides `get(key)`, `need(y0, priority)`, `start()` and `stop()`.

## Acceptance criteria
1. **Unit, brute force:** `sweptSpans` equals the union of `footprint` over the cells, for random cells, sides 1–127, and clipping at the edges.
2. **Unit, random strokes:** `brushSpans` gives tiles byte-equal to calling `brush` per cell, with and without a base. When per-cell brushing would reach the cap, it returns `"full"` and changes nothing.
3. **Unit, fake source:**
   - Each band is read at most once.
   - A second stroke over the same area reads no imagery.
   - Every read has `decodedBytes` ≤ `MAX_READ_BYTES`.
4. **Unit:**
   - The bands requested follow F2's three cases.
   - `compactMask` returns `"all"` or `"none"` for uniform bits.
   - Masks equal `nodataMask` with spec 022's rule A.
5. **Unit:**
   - A whole 11,000² raster's masks stay cached.
   - Past `MASK_BYTES` the least recently used arrays go first.
   - Uniform windows hold no array.
6. **Unit, fake loader and source:**
   - Background reads wait while the loader is busy, run one at a time in `bandOrder`, and pause during an import.
   - A stroke's or hover's band jumps ahead of queued background bands.
   - Opening a raster stops them.
   - After they finish, a stroke anywhere reads no imagery.
7. **Unit:**
   - With a base, copy-on-touch on a cached window reads no imagery.
   - Windows in up to 4 rows already read cause no label-file read.
8. **Unit, spy:** after hovering in Paint and letting idle callbacks run, the overlays of the 5x5 tiles around the footprint call `tileQuads` 0 times.
9. **E2E, generated 4,096² RGBA fixture in 1-row strips, a scripted 2,000 px stroke at size 127 after background reads finish:**
   - no imagery reads;
   - one `PaintOp` per pointer move;
   - tiles byte-equal to the stroke with F6 off.
10. **These pass:**
    - spec 003 criteria 9–14;
    - spec 010 criteria 3–8;
    - spec 014 criteria 6–8 and 12;
    - spec 016 criterion 5;
    - spec 018's alignment criteria;
    - spec 020 criteria 7 and 8;
    - spec 022 criteria 5 and 6.

    `npm run check` passes.
