# 054: Fill tool

**Status:** Proposed by Rahual (2026-11-06); not yet approved. The code is in the same pull request so the tool can be tried, and the answers below are implemented as recommended. Scope and answers are Gage's to change. **ADRs:** none (no dependency; ADR 0009's hand-rolled pattern is followed). **Builds on specs 003, 014, 023, 033, 037, 046 and 049.**

**Request** (Rahual, 2026-11-05, correcting the 8-class pseudo-labels on the drone chunks): "add fill tool". Correcting a mask mostly means recolouring whole blobs, which is slow with the brush.

## Open questions (recommended answers are what the code does)
1. **Key.** `F`.
2. **Reach.** A fill reads at most the clicked tile and 4 tiles each way (81 tiles, about 1000 px from the click), then stops and says so; a second click continues. A larger reach costs more reads and undo memory per click (ADR 0015's 32 MiB).
3. **Connectivity.** 4-connected, so a fill doesn't leak through diagonal gaps.

**Goal:** In Fill mode a click gives the connected region under it the selected class, as one undoable edit.

## Scope
1. **Mode.** `BrushMode` gains `"fill"`, with an `#mode-fill` button between Erase and Smart and key `F`. It is disabled exactly when Paint is (spec 019), shows hidden labels when chosen, and hiding labels selects Pan (spec 016). As in Smart mode, drags pan, a click is a press and release within 4 px on a raster cell, Alt+click picks (spec 038), and a Shift+left press is kept from MapLibre's box zoom. In Fill mode double-click zoom is off and the cursor is a crosshair.
2. **Fill.** A click reads the clicked pixel's effective label (stored tile, else the mask's, else 0) and fills the valid pixels 4-connected to it that share that label, unlabelled included. Imagery nodata is never filled and stops the fill. Tiles are read one round at a time as the fill enters them (`floodFill`), within `FILL_REACH`. The result is one spec 023 `PaintOp` (spans, the selected value, `erase: false`) on a fresh `UndoHistory` stroke, ended at once, so base tiles are copied on touch (spec 014) and Ctrl+Z and redo work (spec 037). The message says `Filled <n> px.`, adding when the fill got as far as its reach that a part may be left to click (it doesn't read past the reach to find out). A click on the selected class says so and changes nothing; a click on nodata says there is no imagery. Clicks are ignored while a fill is read or applied, while strokes are still queued (their tiles are about to change), during a peek (spec 034) and while labels are locked (spec 004). Undo, Import labels and Export labels wait for a fill, as they do for the paint queue. Leaving the mode or opening a raster drops a fill still reading.
3. **Status and help.** `#status-tool` shows `Fill · <class>`, with ` · reading…` while a fill runs; Smart's ` · reading…` shows only in Smart mode. `SHORTCUTS` gains `F` (Fill) and Click (Fill the area under the pointer).

**Out of scope:** erasing with a fill; a tolerance on imagery colour; fills past the reach in one click; a polygon tool (a draft exists and can follow as its own spec).

## Interfaces
- `core/fill.ts` (pure): `FILL_REACH = 4`. `fillTile(labels: Uint8Array | null, mask: ValidMask, t: Window, target: number, bits: Uint8Array, seeds: number[]): FillEdges` spreads inside one tile from seed indices, sets `bits`, and returns the edge rows and columns it newly filled. `edgeSeeds(dims, t, edges)` turns those into each neighbouring tile's window and seed indices, and `inReach(cell, x0, y0)` says whether a tile is within the reach.
- `io/fill.ts`: `floodFill(dims, cell, value, read, stop?): Promise<FillResult | "nodata" | "same" | null>` and `fillReader(imagery, store, base, cache): FillRead` (stored tile, else `maskedBaseTile` with the cached valid mask).
- `ui/fill.ts`. `ui/clickTools.ts` owns Smart and Fill for `ui/labels.ts`, which stays under 200 lines. `map/brush.ts` `Deps.click` and `Deps.discard` now fire in both modes.

## Acceptance criteria
1. **Unit (core):** `fillTile` fills 4-connected pixels only, reports edge pixels per side, treats null labels as 0, stops at nodata, and on a second call keeps earlier bits and reports only new ones. `edgeSeeds` indexes into partial edge tiles correctly and gives nothing past the raster; `inReach` is true 4 tiles away and false 5.
2. **Unit (io):** `floodFill` equals a whole-raster flood fill on a 700 x 600 raster with partial edge tiles, for 5 cells. It reads only tiles the region reaches, each once and none larger than a tile. It returns `"nodata"` and `"same"` after one read, stops at `FILL_REACH` with `clipped` and exactly 81 reads, doesn't call a raster edge a clip, returns null once `stop` is true, and rejects on a failed read.
3. **Unit (io, real store, mask base, `MaskCache` and `PaintQueue`):** a fill of an unedited imported mask, then of the region around it (part stored, part base), gives the expected labels and stops at nodata; two undos leave no stored tile.
4. **Unit (ui/fill):** one op per click as one ended stroke; clicks are ignored while one reads or lands, while strokes are queued and while locked; `"same"`, `"nodata"` and failures push nothing and say why; cancel mid-read pushes nothing.
5. **Unit (ui/clickTools):** a click reaches only the selected tool; leaving Fill or opening a raster drops a fill still reading; Undo, Import and Export are told when a fill starts and ends, and `labels.ts` gates `blocked` and `busy` on it; `reading` is false for a tool that isn't selected.
6. **Unit (map/brush):** in Fill a left click calls `click`, a drag or an off-raster click doesn't, a right click calls `discard`, and only double-click zoom is turned off; Paint still turns off all three handlers and Smart none. While blocked (a peek) Fill takes no click, and Smart's clicks are unchanged.
7. **Unit (ui/labelKeys):** `F` selects Fill through `MODES`, blocked like `B` (covered by spec 033 criterion 2's harness: `F` is a `MODES` entry).
8. **Unit:** `formatTool` and `SHORTCUTS` as in scope 3; spec 039 criterion 1 passes.
9. **E2E (imported 16 px block mask):** a Fill click recolours exactly one block, an unlabelled block fills, a click on the selected class changes nothing, and Undo and Redo work.
10. **E2E (nodata imagery):** a fill labels every valid pixel and none in the nodata block; a click on nodata labels nothing and leaves Undo disabled.
11. **E2E:** the button's `aria-pressed`, title and disabled state, Escape to Pan, hidden labels, and the `#help` rows.
12. `npm run check` passes apart from the 4 tests that fail on `main` at 5594d74 (README wording, and one Ctrl/Cmd title on macOS). Specs 033, 046 and 049's criteria pass.
13. **Docs:** README describes Fill. CLAUDE.md's `core/` line should gain "fills"; only Gage edits CLAUDE.md.
