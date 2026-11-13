# 019: Progress while a raster opens, and no painting before the imagery shows

Status: Approved (Gage, 2026-10-29: "approve all"). The request (Gage, 2026-10-29): the 1.49 GB file "eventually showed. It just took a while and there was no loading indication. A progress bar would be nice", and "Don't allow painting with no image." Spec 020 builds on this one.

**Amended by spec 061 (2026-11-12):** the tester file `open-progress.tester.spec.ts` is deleted, and so are `race-opens.tester.spec.ts`'s two held-open cases. Criteria 4-9 stay covered by `open-progress` 60-151, `imagery` 84, `raster-race` 16 and 34 and `race-opens.tester` 8. Lost: navigation and Import labels while the preview loads, and out-of-order held opens.

## Decided (Gage, 2026-10-29)
1. No Cancel button. By the time the preview starts, the raster is already open, so Cancel would leave it with no imagery. Choosing another file replaces it and stops the old reads (criterion 5).
2. Import labels, Export labels and class edits stay allowed while the preview loads. They don't paint, and an import selects Pan (spec 016).

## Goal
While a raster opens, show a progress bar that tracks real work, always say why an open failed, and don't allow painting until the imagery is drawn.

## Where the time goes (main 0fe9393)
- **Reading the header** (`openFile`, `openRaster`): a few small reads, effectively instant.
- **`buildPreview`** (`io/pipeline.ts:29`): reads every 256x256 window of the full-resolution image, one at a time, on the main thread.
  - Its time grows with the file size, and it is the slow stage.
  - Its progress is countable: windows done out of the windows it will read.
- **`warpPreview`**: one projection per preview pixel (at most 1024x1024). Its cost doesn't depend on the file size.
- **`showPreview`**: effectively instant.

## Scope
**Progress bar:** `<progress id="open-progress" hidden>` in `#panel`, after `#raster-info`.
- **Reading the header:** shown with no value (indeterminate).
- **Building the preview:** value = windows done, max = windows total. `#message` reads "Building preview…".
- **Warping:** indeterminate again. `#message` reads "Drawing preview…".
- **Hidden** when the open ends: "Raster opened.", an error, a refusal, Cancel at the discard prompt, or replacement by a newer open.

**No painting before the imagery shows.**
- A raster still opens in Pan (spec 016).
- `#mode-paint` is disabled from the moment the raster opens until its preview is drawn.
- **Preview fails:** Paint stays disabled for that raster, and the error is shown.
- **Replaced by a newer open:** the new raster starts disabled.
- **Cancel at the discard prompt:** the old raster keeps its state.
- **While Paint is disabled:**
  - Space, middle-drag, the wheel and WASD pan as usual.
  - Keys 1–9 pick a class and `[ ]` resize the brush (no paint results).
  - Undo, Import labels, Export labels, class edits, Opacity and Show labels still work.
  - Because no stroke can start, the paint queue stays empty.

**A newer open stops an older one's preview reads.**

**Every failure on the open path, and every paint read error, shows a non-empty message.**
- Today a FileReader failure rejects with a `ProgressEvent`, which has no `.message` (geotiff 3.0.5 `source/filereader.js:24-25`).
- `errorText` and `readErrorMessage` return its `.message`, which is `undefined`, and `say(undefined)` blanks `#message`.

**Out of scope:** speedups and full resolution (spec 020), Cancel, rejecting large files.

## Interfaces
- **`io/pipeline.ts`:** `buildPreview(source, maxSide, opts?: { stretch?: [number, number]; onProgress?: (done: number, total: number) => void; signal?: AbortSignal })`.
  - No caller passes `stretch` today.
  - An aborted `signal` rejects with `AbortError` before the next window read.
- **`ui/messages.ts`:**
  - Adds `MESSAGES.rasterUnreadable = "Couldn't read this file."`, `buildingPreview` and `drawingPreview`.
  - `errorText(e)` moves here from `main.ts`. It and `readErrorMessage(e)` return `rasterUnreadable` when `e` is not an `Error` or its message is empty.
- **`ui/labels.ts`:** gains `imageryReady(ready: boolean)`, which sets `#mode-paint` `disabled`.
- **`core/`:** no change.

## Acceptance criteria
1. Unit, fake source: `buildPreview` calls `onProgress` once per window it reads. `done` runs 1..total in order, and `total` equals the number of reads.
2. Unit: preview RGBA bytes and corners are unchanged for the existing fixtures.
3. Unit: if `signal` is aborted while window k is being read, no window after k is read, and the call rejects with `name === "AbortError"`.
4. E2E: `#open-progress`, recorded with a MutationObserver, is visible and has a numeric `value` at least once before "Raster opened.". It is hidden afterwards.
5. E2E, first open slowed by a test hook, then a second file opened:
   - the first open's reads stop;
   - the second raster's preview shows, with "Raster opened.";
   - the bar is hidden at the end.
6. E2E: a refused raster (the antimeridian fixture) shows its message, and the bar is hidden.
7. E2E: Cancel at the discard prompt hides the bar and keeps the old raster, its labels and its Paint state.
8. E2E, slowed open:
   - Before "Raster opened.", `#mode-paint` is disabled, `#mode-pan` is pressed, and a left drag changes no tile.
   - Keys 1–9 and `[ ]` still work.
   - Once the preview shows, `#mode-paint` is enabled.
9. E2E: when the preview's reads fail, a non-empty message shows and `#mode-paint` stays disabled. The failure is simulated with a hook that rejects with a `ProgressEvent`.
10. Unit:
    - `errorText` returns `MESSAGES.rasterUnreadable` for `new ProgressEvent("error")`, `undefined` and `new Error("")`.
    - `readErrorMessage` does the same.
    - `Error("x")` still gives `"x"`.
11. `npm run check` passes.

## Limits that can make a file fail (not fixed here)
- **Codecs geotiff doesn't support:** old-style JPEG (6), JPEG 2000 (34712) and others fail with the library's raw text, e.g. "Unknown compression method identifier: 34712".
- **Single-strip files:** every window decodes the whole image (spec 020 refuses these at full resolution).
- **Label export:** stops at 4 GiB (classic TIFF, `io/tiffWriter.ts:7`).
