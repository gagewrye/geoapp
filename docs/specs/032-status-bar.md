# 032: Status bar

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none. **Builds on spec 031** (`#save-state`).

**Goal:** One bottom strip shows where the cursor is, what the brush will do, and what the app is doing. Only errors show in red.

## Scope
1. A `<footer id="status">` bar, 28 px high, spans the bottom of the page under the sidebar and the map. Left to right it holds:
   - `#status-lonlat`: cursor lon/lat, 5 decimals, written `31.20410 N 29.91870 E`.
   - `#status-px`: the raster pixel `px 5512, 3301`, blank off the raster or before one opens.
   - `#status-zoom`: `z 17.3`.
   - `#status-tool`: `Paint · Water · 7 px`, from mode, selected class and brush side.
   - `#save-state`, moved from the sidebar (spec 031).
   - `#message`, moved from the sidebar.
   - The open and import progress bars and the import Cancel button, moved from the sidebar.
2. The cursor fields update at most once per animation frame. They are blank while the pointer is off the map.
3. Messages get a kind: `say(text, kind = "info")`, plus `"error"`.
   - Error kind: every `errorText` / `readErrorMessage` result, `labelFile`, `classTable`, `className`, `labelLimit`, `editLimit`, `maskGone`, `imageryUnreadable`, `largeBlocks`, `rasterAntimeridian`, `tooMany`, and spec 031's `Not saved` text.
   - Everything else is info.
   - `#message` gets class `error` for errors only. The CSS colours only `.error` red.
4. The status bar is visible before a raster opens; its raster fields are then blank.
5. **Save retries** (spec 031 follow-up). When a save of the current raster fails, it is retried after `RETRY_MS` (30 s), as the pending-snapshot path does. New changes still save on the normal 2 s delay.
   - After a quota error (`QuotaExceededError`), the mask copy is left out of every save until the next import. Tiles and the record are still written.
   - A restore of such a session then follows spec 031's missing-copy path.
   - Today a full disk re-streams Chunk 11's 593 MB mask every 2 s without end (`ui/persist.ts:125-130`).
6. **Discard question.** When labels are open, `MESSAGES.discard` (asked on opening another raster) becomes `Close these labels? They stay saved in this browser.` While a snapshot is pending, spec 031's pendingDiscard question is asked instead.

**Out of scope:** scale bar, pixel band values, any layout change beyond adding the bar (spec 035).

## Interfaces
- `core/status.ts`:
  - `formatLonLat(lon: number, lat: number): string`: N/S and E/W suffixes, absolute values, 5 decimals.
  - `formatTool(mode: BrushMode, className: string, side: number): string`.
- `pixelAt` (existing) gives the pixel. A pixel is shown only when `0 ≤ col < width` and `0 ≤ row < height`.
- `say` in `ui/main.ts` gains the `kind` argument. Callers listed in scope 3 pass `"error"`.

## Acceptance criteria
1. **Unit:**
   - `formatLonLat(29.9187, 31.2041)` is `31.20410 N 29.91870 E`.
   - `formatLonLat(-0.5, -12)` is `12.00000 S 0.50000 W`.
   - `formatTool("paint", "Water", 7)` is `Paint · Water · 7 px`.
   - Pan gives `Pan · Water · 7 px`.
2. **Unit:**
   - Each error message listed in scope 3 sets class `error` on `#message`.
   - `Raster opened.`, `Labels exported.`, `Importing labels…` and `Seeded …` do not.
3. **E2E:**
   - Moving the pointer to a known pixel of the fixture shows its `px` and lon/lat, matching `pixelAt`.
   - Moving off the raster blanks `#status-px`.
   - Zooming changes `#status-zoom`.
4. **E2E:** pressing `]`, selecting class 2 and selecting Paint each update `#status-tool`.
5. **E2E:**
   - Opening shows `#open-progress` inside `#status`.
   - Importing shows `#import-progress` and `#import-cancel` there, and Cancel still cancels (spec 021's criteria pass).
6. **E2E:** `#status` stays in the viewport at 1280×720 and at 800×600, with the map above it, not under it.
7. **Unit, fake store and fake timers:**
   - A write rejecting with `QuotaExceededError` is next retried at 30 s, not at 2 s, and that retry writes tiles and the record but no mask copy.
   - Over 5 minutes of failures, `saveBase` is called at most once.
   - After a new import, the copy is attempted again.
8. **Unit:**
   - Opening another raster with labels and nothing pending asks the scope 6 text.
   - With a snapshot pending, it asks spec 031's question instead.
9. `npm run check` passes.
