# 046: Smart select

**Status:** Approved by Gage 2026-10-31, with the recommended answers. **ADRs:** 0031 onnxruntime-web, 0032 SAM 2.1 Tiny weights (both Accepted). **Builds on specs 003, 010, 014, 019, 023, 033, 037, 038 and 039.** Amends spec 033 scope 3 (Escape) and takes up ADR 0012 option (i) for one small model.

**Decided (Gage, 2026-10-31):** the recommended answer to each question at the end:
1. SAM 2.1 Tiny.
2. A 1024² window of native pixels.
3. A preview, then Enter.
4. Fill overwrites existing classes.
5. No WebGPU means no Smart select.
6. Same-origin weights from `npm run fetch-model`.
7. `M` selects Smart, and Escape discards the prompt first.
8. Bands as displayed.

**Goal:** In Smart mode, a click on the imagery previews a SAM mask of the region under it, and Enter fills that mask with the selected class as one undoable edit.

## Scope
1. **Mode.** `BrushMode` gains `"smart"`, with an `#mode-smart` button and key `M`. Choosing it shows hidden labels (spec 016). It is disabled while Paint is (spec 019). Choosing it first checks for a WebGPU adapter with `shader-f16`, before any download. Without one, it shows `Smart select needs WebGPU.` (info), the mode is unchanged, and the button stays disabled with that `title`. In Smart mode, drags pan as in Pan mode, and there is no footprint or stroke. Alt+click still picks (spec 038).
2. **First use.** When Smart is chosen and the model isn't in Cache Storage, `confirm("Smart select downloads an 80 MB model once. Download it?")` comes first; Cancel leaves the mode as it was. The download and session load show spec 019's progress with Cancel. Later sessions load from the cache with no confirm and no network request. ORT is a dynamic import, so the main bundle doesn't contain it.
3. **Prompt.** A left click (press and release within 4 px) adds an include point, and a right click adds an exclude point. The first point fixes the window: `samWindow` of its cell. A point outside that window starts a new prompt, discarding the pending one. Escape discards a pending prompt and keeps Smart mode; with no prompt, Escape selects Pan as before.
4. **Imagery.** The window is read as 256×256 `readSamples` calls of `displaySamples` bands, one at a time, mapped to RGB with `toRgba` and the preview's ranges. So the model sees what the user sees, and nodata and alpha-0 pixels are the ImageNet mean grey (0 after normalisation). `samInput` builds the encoder tensor.
5. **Embedding.** It is computed on the first point of a prompt, in a dedicated worker, unless the worker already holds the embedding for that same window. The worker holds one. Points added while it encodes are decoded once it finishes. A result for a superseded prompt is dropped. Opening a raster drops the embedding and the prompt.
6. **Preview.** Each decode uses the include and exclude points. With one point, the decoder returns three masks and the one with the best score is shown; with more points, one mask is shown. The mask shows in the selected class colour at opacity 0.5 in a new layer slot `smart` between `label-` and `brush-hover`, drawn as ADR 0019 quads of the window. It recolours on select or recolour.
7. **Commit.** Enter, or the `#smart-apply` button, pushes one spec 023 `PaintOp` with spans from `maskSpans`, the selected class value, `erase: false`, and a fresh `UndoHistory` stroke, which is ended at once. So, as with Paint:
   - nodata is skipped;
   - base tiles are copied on touch (spec 014);
   - existing classes are overwritten;
   - a cap breach changes nothing and shows the label-limit message;
   - Ctrl+Z undoes the whole fill and redo works (spec 037).

   A successful commit clears the prompt. Enter is ignored while the labels are locked (spec 004), with no mask shown, in text fields, and on a focused button.
8. **Status and help.** `#status-tool` shows `Smart · <class>`, and while encoding, `Smart · <class> · reading…`. `SHORTCUTS` gains `M` (Smart select), Enter (Apply smart selection), Click / Right click (Include / exclude a point), and Esc (Discard the selection).

**Out of scope:** box prompts; removing single points; erase with a mask; windows from overviews when zoomed out; a WASM fallback; text prompts; automatic whole-image segmentation; fine-tuning; a band picker.

## Interfaces
- `core/smart.ts` (pure):
  - `SAM_SIDE = 1024`.
  - `samWindow(dims, col, row): Window`. The window is SAM_SIDE square, or the raster's side where smaller. `x0 = clamp(256·round((col − 512)/256), 0, max(0, width − 1024))`, and likewise for y0.
  - `samInput(rgba: Uint8ClampedArray, w: number, h: number): Float32Array`. It gives 1×3×1024×1024 CHW values `(v/255 − mean)/std` with ImageNet mean and std. Alpha-0 pixels, and padding beyond w×h, are 0.
  - `promptPoints(points: [number, number][], w: Window): Float32Array`. Each point maps to `cell + 0.5 − origin`, in encoder pixels.
  - `bestMask(scores: Float32Array): number` is the first maximum.
  - `maskBits(logits: Float32Array, side: number, w: Window): Uint8Array`. It upsamples `side²` logits covering SAM_SIDE² bilinearly (half-pixel centres) and thresholds them at > 0. It returns w.width × w.height bits as 0 or 1.
  - `maskSpans(bits: Uint8Array, w: Window): Span[]` gives row runs in raster coordinates. The preview canvas is `paintLabels(bits, [colour], rgba)`.
- `io/segmenter.ts`: `interface Segmenter { encode(input: Float32Array, key: string): Promise<void>; has(key: string): boolean; decode(points: Float32Array, labels: Uint8Array): Promise<{ masks: Float32Array; scores: Float32Array; side: number }> }`. `loadSegmenter(onProgress, signal): Promise<Segmenter | "no-webgpu">` is the ORT worker (ADR 0031). `io/modelCache.ts` `fetchCached(url, onProgress, signal): Promise<Uint8Array>`.
- `ui/smart.ts` wires it. The e2e hook `__geoapp.segmenter` replaces the Segmenter.

## Acceptance criteria
1. **Unit (core):**
   - `samWindow`, by brute force over cells of 300×300, 1024×1024 and 3000×2000 rasters: the cell is inside the window, and the window lies within the raster. It is at least 384 px from each window edge that isn't a raster edge. Its side is min(1024, raster side).
   - `samInput` matches a hand-computed pixel, gives 0 at an alpha-0 pixel and in padding, and has length 3·1024².
   - `promptPoints` maps a window's corner cell to (0.5, 0.5).
2. **Unit (core):**
   - `maskBits` with side 256 equals a brute-force bilinear reference on random logits, for a full window and a 300×200 one.
   - `maskSpans` of the bits covers exactly the 1-bits.
   - `bestMask([0.2, 0.9, 0.9])` is 1.
3. **Unit (ui, fake Segmenter that returns a square around each include point):**
   - A first click encodes once, and a second click in the window decodes without encoding.
   - A click outside the window starts a new prompt.
   - A decode that resolves after Escape changes nothing.
   - Opening a raster drops the prompt.
   - Enter pushes exactly one `PaintOp`, and its spans are `maskSpans` of the shown mask.
4. **Unit (io):** `fetchCached` with a fake `caches` and `fetch` fetches once, and a second call reads only the cache. A cancelled download stores nothing.
5. **E2E (fake Segmenter, nodata imagery):**
   - In Smart mode, a click then Enter labels the square with the selected class, except imagery nodata.
   - One Ctrl+Z restores every tile, and Ctrl+Y redoes the fill.
   - Escape before Enter labels nothing.
6. **E2E:**
   - With 256 tiles stored, a commit touching a new tile shows the label-limit message and changes nothing.
   - While an export runs with a paused sink, Enter changes nothing.
7. **E2E:** the `#mode-smart` `aria-pressed`, `M`, Escape, `#status-tool` and `#help` entries behave as in scope 1, 3 and 8. Spec 039 criterion 1 passes with the new keys. With `navigator.gpu` removed by an init script, pressing `M` shows the WebGPU message, leaves the mode unchanged, and requests no file under `models/`.
8. **Build:** the entry chunk in `dist/` doesn't contain "onnxruntime". The request log from load through a fake-Segmenter commit shows only same-origin requests (spec 013 criterion 6).
9. **Manual (tester, Gage's machine, real model):** the tester records Chrome's version and the GPU, the download size, and the encode and decode times. A click on a field or building gives a plausible mask, and a reload loads with no network request for the model.
10. `npm run check` passes. Specs 003, 010, 033, 037 and 038's e2e criteria pass.
11. **Docs:**
    - README describes Smart select and credits SAM 2.1 (Apache-2.0) and onnxruntime-web (MIT).
    - `public/models/sam2.1-hiera-tiny/LICENSE` is shipped with the weights.
    - ADR 0012's Status names ADR 0031.
    - CLAUDE.md's `core/` line gains "smart-select windows and masks". Only Gage edits CLAUDE.md.

## Open questions for Gage (recommended default first)
1. **Model:** SAM 2.1 Hiera Tiny fp16, about 78 MB (ADR 0032). The alternative is SlimSAM-77, about 21 MB fp16, which is smaller but rougher.
2. **Window:** 1024×1024 native pixels around the click. The alternative is the current view, which is resampled and changes with zoom. With the default, objects over 1024 px are filled in parts.
3. **Commit:** preview, then Enter. The alternative is to fill on every click, which is faster but needs more undo.
4. **Overwrite:** fill over existing classes, as Paint does. The alternative is to fill only unlabelled pixels.
5. **Without WebGPU or `shader-f16`:** Smart is disabled. A WASM fallback would be single-threaded, because static hosting can't send COOP/COEP, and would take tens of seconds per click.
6. **Weights:** same-origin static files from `npm run fetch-model`, at a pinned revision with a sha256 check, kept out of git. The alternatives are Git LFS, or Hugging Face at runtime, which is a third-party request.
7. **Keys:** `M` for Smart select. Escape discards a pending prompt before it selects Pan.
8. **Bands:** as displayed, meaning bands 1–3, or band 1 as grey, with the preview stretch. No band picker in v1.
