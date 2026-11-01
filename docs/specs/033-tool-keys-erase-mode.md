# 033: Tool keys and an Erase mode

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none. **Builds on specs 003, 016, 019 and 032.**

**Goal:** One key picks each tool, and users without a right button (trackpads) can erase.

## Scope
1. `BrushMode` becomes `"paint" | "erase" | "pan"`.
   - In Erase mode, a left drag erases exactly as a right drag does in Paint mode: the selected class only (spec 003).
   - A right drag in Erase mode also erases.
   - Everything spec 003 says Paint mode does with MapLibre handlers, the cursor and the hover footprint applies to Erase too. The hover ring is dashed in Erase mode so the two modes can be told apart.
2. An `#mode-erase` button sits beside Paint and Pan, with `aria-pressed` like theirs. It is disabled exactly when Paint is (spec 019).
3. Keys, all ignored while a text field has focus, while Ctrl, Meta or Alt is held, or before a raster opens (as `labelKeys` does now):
   - `B`: Paint.
   - `E`: Erase.
   - `P` or `Escape`: Pan. (Spec 046: in Smart mode, `Escape` first discards a pending smart prompt.)
4. A mode key pressed during a stroke takes effect when the stroke ends. B and E do nothing while the button they press is disabled.
5. Spec 016's rule covers Erase: choosing Paint or Erase shows hidden labels first, and hiding labels selects Pan.
6. Spec 032's `#status-tool` shows `Erase · <class> · <n> px`.

**Out of scope:** an eraser that clears every class; a held-key temporary eraser.

## Interfaces
- `map/brush.ts`:
  - `BrushMode` gains `"erase"`. A stroke's `erase` is `mode === "erase" || e.button === 2`.
  - `painting()` is true in both Paint and Erase modes.
- `ui/labelKeys.ts` gains `setMode: (m: BrushMode) => void` and `canPaint: () => boolean` in its deps.
- `core/status.ts` `formatTool` handles `"erase"`.
- No other `core/` change.

## Acceptance criteria
1. **Unit (brush, synthetic pointer events):**
   - In Erase mode, a left press calls `cells(..., erase = true)`.
   - In Paint mode, a left press calls it with false, and a right press with true.
   - In Pan mode, no press calls it.
2. **Unit (labelKeys):**
   - `b`, `e`, `p` and `Escape` call `setMode` with paint, erase, pan and pan.
   - None of them does while focus is in a class-name field, with Ctrl held, or before open.
   - `B` and `E` do nothing while `canPaint()` is false.
3. **Unit:** pressing `p` mid-stroke leaves the stroke running, and the mode is Pan once the stroke ends.
4. **E2E:**
   - Paint a stroke of class 1, press `E`, then left-drag over it: those pixels are 0, and other classes' pixels are untouched.
   - Ctrl+Z restores them.
5. **E2E:**
   - With labels hidden, pressing `E` shows them and selects Erase.
   - Unchecking Show labels in Erase mode selects Pan.
6. **E2E:** the three mode buttons' `aria-pressed` and `#status-tool` follow each key.
7. Spec 003, 010 and 016's e2e criteria pass. `npm run check` passes.
