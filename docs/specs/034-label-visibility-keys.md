# 034: Label visibility keys

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** none. **Builds on specs 016 and 033.**

**Goal:** One key hides or shows the labels, and holding another key lets the user glance at the imagery underneath without losing their tool.

**Decided by Gage (2026-10-30), as drafted:** which peek key? Draft: `` ` `` (`e.code === "Backquote"`, the key left of 1 on US and UK layouts). Alternatives are holding `H`, or `V`.

## Scope
1. `H` toggles Show labels, exactly as clicking `#show-labels` does. Hiding selects Pan (spec 016).
2. Holding the peek key hides the label layers while it is held. Unlike `H`:
   - it does not change the mode, the checkbox or the saved view (spec 031);
   - while peeking, a press on the map starts no stroke, because Paint never applies to labels the user can't see (spec 016);
   - releasing the key, or the window losing focus, shows the labels again;
   - key repeat does nothing;
   - peeking does nothing while a stroke is in progress, or while labels are already hidden.
3. Both keys are ignored while a text field has focus, while Ctrl, Meta or Alt is held, or before a raster opens.
4. Peeking changes only the layers' visibility, not their opacity. Releasing restores the exact previous opacity.
5. **Carried from spec 033's review** (same code, non-blocking there):
   - `labels.open()` calls `keyed.clear()` before `brush.setImagery`, so a mode key queued mid-stroke never applies when a new raster ends that stroke;
   - an e2e step covers `onStroke(false)` applying a queued mode key;
   - the `deferMode` unit tests move from `tests/unit/map/brush.test.ts` to `tests/unit/ui/deferMode.test.ts`, so `tests/` mirrors `src/`.

**Out of scope:** "show selected class only", contour display.

## Interfaces
- `ui/labelView.ts`:
  - gains `toggle(): void`;
  - gains `peek(on: boolean): void`, which calls `applyLabelView` with `visible: show.checked && !on` and leaves the checkbox alone;
  - gains `peeking(): boolean`.
- `map/brush.ts` gains `setBlocked(on: boolean)`. No stroke starts while it is on, and the cursor shows as locked.
- No `core/` change.

## Acceptance criteria
1. **Unit (labelKeys):**
   - `h` calls `toggle` once per press.
   - The peek key calls `peek(true)` on keydown and `peek(false)` on keyup.
   - A repeated keydown (`e.repeat`) calls nothing.
   - A window `blur` calls `peek(false)`.
2. **Unit (labelKeys):** neither key acts while focus is in a text field, with Ctrl held, before open, or (for peek) during a stroke.
3. **Unit (labelView):**
   - `peek(true)` then `peek(false)` leaves `#show-labels` checked and the opacity unchanged.
   - `toggle()` twice returns to the start, with one Pan selection on the hide.
4. **E2E:**
   - In Paint mode, hold the peek key: the label layers' visibility is `none`.
   - A left press on the map changes no tile.
   - Release: visible again, still Paint mode, and a stroke paints.
5. **E2E:** pressing `H` hides the labels, unchecks `#show-labels` and selects Pan. Pressing it again shows them.
6. **E2E (scope 5):** in Paint mode, mouse down on the map, press `e`, then open a new raster before mouse up. `#mode-erase` is never `aria-pressed="true"` (a MutationObserver records none), and afterwards Pan is pressed.
7. **E2E (scope 5):** in Paint mode, mouse down on the map and press `p`: Paint stays pressed. Mouse up: Pan is pressed.
8. **Scope 5:** `tests/unit/ui/deferMode.test.ts` holds the `deferMode` tests, and `tests/unit/map/brush.test.ts` no longer imports `deferMode`.
9. `npm run check` passes.
