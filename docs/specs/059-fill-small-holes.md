# 059: Fill also fills small holes it encloses

**Status:** Accepted (2026-11-11). Gage approved it and answered its questions on 2026-11-11 (below). **ADRs:** none (no dependency or architecture change). **Amends spec 054** scope 2 and criterion 3 (`floodFill` no longer equals a plain flood fill). Shares no files with specs 055-058.

**Request** (Gage): "the Fill tool should also fill small isolated holes enclosed by the fill region, with a 2 px cap." Agreed: a hole is a patch whose label differs from the fill's target, fully enclosed by the filled region, at most 2 px. It takes the selected class in the same fill and the same undo step. Nodata is never filled. A patch touching the region's outside or the edge of the reach stays. The region still spreads 4-connected.

## Decided by Gage (2026-11-11)
1. **Target unlabelled.** Enclosed specks of other classes are overwritten too: their label differs from the target.
2. **"2 px" is area:** at most 2 pixels in total.
3. **Hole connectivity is 4-connected.** Pixels that touch only at a corner are separate patches. So each pixel of a diagonal line can be filled as its own 1 px hole.
4. **Nodata in a patch.** A patch with any nodata pixel is not a hole, and all of it stays.
5. **Hover hint.** Spec 057's `fill` hint is unchanged.
6. **Spec 054** is accepted as built.

**Goal:** A Fill click also gives the selected class to each patch of at most 2 px that its region fully encloses, in the same op.

## Scope
1. **Definition.** R is spec 054's region: valid pixels 4-connected to the click with its label, within `FILL_REACH`. A pixel is *unknown* if it is off the raster or in a tile the fill didn't read; every tile past the reach is unread. Unknown pixels are never in R. A *patch* is a 4-connected component of the pixels not in R, unknown ones included. A patch is a hole when all of these are true:
   - it has at most `HOLE_MAX = 2` pixels;
   - it holds no unknown pixel, so a patch 4-connected to unknown pixels is never a hole;
   - all its pixels are valid imagery.
   Then every 4-neighbour outside the patch is in R, which is what *enclosed* means here. Holes are found against R alone, before any hole is added. The region never spreads from a hole.
2. **Corners don't connect.** Take a pixel whose 4 sides are all in R but whose diagonal neighbour is outside R. It is a 1 px hole and is filled, even when that diagonal neighbour joins the outside. A pixel with any side on the outside stays, because it is part of the outside's patch. So the fill never spreads past R's 4-connected outline, except for those diagonal-gap pixels.
3. **Op.** Hole pixels already holding the selected value are left out, since they would not change. The rest join R's bits before `maskSpans`, so they land in the one `PaintOp` and the one undo stroke. `Filled <n> px.` counts them. `"same"`, `"nodata"`, `clipped` and the messages are unchanged.
4. **Tile by tile.** The hole test is local. A pixel P not in R is a hole pixel when it is valid and known and one of these is true:
   - all 4 of its sides are in R;
   - exactly one side Q is not in R, Q is valid and known, and Q's other 3 sides are in R.

   The pass reads no tile. It uses only the tiles (labels, mask, bits) that `floodFill` already holds, at most 81, and looks up a neighbour across a seam in that tile's bits. Each tile reports only its own pixels, so a 2 px hole on a seam is filled half by each tile.
5. **Docs.** The README's Fill sentence gains "and specks of up to 2 px it encloses". On the 059 branch, spec 054's status becomes Accepted (decision 6), and it gets an "Amended by spec 059" line.

**Out of scope:** larger or configurable caps, 8-connected spreading or patches, holes in Polygon fills, and a hole-only undo step.

## Interfaces
- `core/holes.ts` (pure): `HOLE_MAX = 2`.
  - `type RegionView = { inRegion(x, y): boolean; known(x, y): boolean; valid(x, y): boolean; label(x, y): number }` uses raster coordinates. For unknown pixels, `known` is false and the other three are false or 0.
  - `holePixels(t: Window, view: RegionView, value: number): number[]` returns tile-local indices of t's pixels in holes, minus those labelled `value`, sorted.
  - `regionView(dims, held: (key: string) => { t: Window; labels: Uint8Array | null; mask: ValidMask; bits: Uint8Array } | undefined): RegionView`.
- `io/fill.ts` `floodFill`: same signature and result type. After the flood, it collects `holePixels` for every held tile, sets those bits, then builds spans.

## Acceptance criteria
1. **Unit (core, `holePixels` on hand-built views):** in a region of 1s filled with value 3, these are filled:
   - a 1 px 0 and a 1 px 2;
   - two 4-adjacent 0s;
   - two diagonal 0s, each as its own 1 px hole;
   - each pixel of a diagonal line of three 0s;
   - a 0 pixel whose 4 sides are in R and whose diagonal neighbour joins a large 0 area outside (the diagonal gap).

   Each of these stays:
   - a 4-connected 3 px patch (a line and an L);
   - a notch with one side on the outside;
   - a pair with one pixel touching the outside;
   - a speck 4-adjacent to the raster edge or to an unknown pixel;
   - a 1 px nodata, and a 2 px patch of one nodata and one 2;
   - a pixel already labelled 3.
2. **Unit (core):** with the target 0, a 1 px class-2 speck in a 0 region is returned (decision 1). `regionView` gives false or 0 off the raster and for keys that `held` doesn't have, and reads null labels as 0.
3. **Unit (core, seams):** with 256 px tiles, these give the same result as a whole-window check, and each pixel is reported only by its own tile: a 2 px hole split across a vertical seam, one split across a horizontal seam, a diagonal pair across a four-tile corner (two 1 px holes), and a 1 px hole at a tile corner.
4. **Unit (io, amends spec 054 criterion 3):** `floodFill` on the 700 x 600 raster equals the whole-raster 4-connected fill plus its holes, for 5 cells. The labels include specks of 1, 2 and 3 px, some on seams. It reads the same tiles, each once, as for the same raster with no specks. A speck 4-adjacent to the outermost column of the reach stays, and the same speck one column in is filled. `pixels` equals the spans' total.
5. **Unit (io, real store, mask base, `PaintQueue`):** a fill over an imported mask with a 1 px speck labels the speck. One undo restores the speck's old class and leaves no stored tile.
6. **E2E (an imported mask: spec 054's blocks, with specks in the value-2 block at 400..415):** with class 3, a Fill click in the block labels:
   - a 1 px class-1 speck;
   - a 2 px unlabelled pair;
   - each pixel of a diagonal line of three 0s.

   It leaves a 4-connected 3 px speck and a 0 notch on the block's edge, and the message's count equals the pixels that changed. One `#undo` restores every speck and the block, and `#redo` fills them again.
7. **E2E:** a Fill click on an unlabelled block holding a 1 px class-1 speck gives the speck the selected class.
8. Spec 054 criteria 1, 2 and 4-13 still pass. Criterion 10's blocks have no holes, so its counts are unchanged. The `fill` hint equals spec 057's text. `npm run check` passes.
9. **Docs:** scope 5 is done.

**Note for Gage:** CLAUDE.md's `core/` line could gain "fills, polygons and fill holes". Only Gage edits CLAUDE.md.
