# 067: Smart select makes boxes in the Boxes kind

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** none. It reuses SAM 2.1 Tiny and its loading (ADRs 0031, 0032 and 0035), with no new model. **Builds on specs 046, 049, 055, 056 and 064.** It is part of the series in spec 062.

## Decided (Gage, 2026-11-12: the recommended answers)
1. **Disconnected masks.** SAM can return a mask in several parts. The box goes around all of them, and the user resizes it if needed.
2. **The window edge.** Smart select sees a 1024 px window, so a larger object's mask stops at the window's edge. The box is made anyway and is selected, and a message says it may be cut off.
3. **After Apply.** The new box is selected, and Smart stays the mode, so the next click starts the next object. Pressing `R` then lets the user adjust the handles.

**Goal:** In the Boxes kind, Smart select previews the bounding box of SAM's mask, and Enter adds that box in the selected class as one undoable step.

## Scope
1. **Which output.** Smart's output follows the kind. In Masks it is unchanged (spec 046). In Boxes it is a box.
   - The mode, the WebGPU check, first use, prompt, window, encoding and the mask choice are all spec 046's, as amended by specs 049, 055 and 056.
   - Switching kind while in Smart keeps the mode and the pending prompt (spec 062 scope 3). Only the preview and Apply's output change.
2. **Preview.** In Boxes, each shown mask also shows `maskRect(bits, window)` in the box layer's edit source:
   - a dashed class-colour outline;
   - the mask itself at opacity 0.3 instead of 0.5.

   An empty mask shows no box.
3. **Apply.** Enter or `#smart-apply` adds `maskRect` as a box with the selected class.
   - It is one undo entry and is applied at once. There is no paint queue, because no tile changes.
   - The new box is selected and the prompt clears. The worker keeps its embedding, so a next click in the same window decodes without encoding again (spec 046 scope 5).
   - Enter is ignored as in spec 046 scope 7: while locked, with no mask shown, in text fields and on a focused button.
4. **Edge.** When the box touches a side of the window that isn't a raster edge, the message is `The box reaches the edge of Smart select's window; check its size.` (info).
5. **Discard.** Escape or a right click discards the prompt as now (spec 049). With no prompt, Escape clears a selected box, then selects Pan (spec 064 scope 4).
6. **Status and help.**
   - `#status-tool` shows `Smart box · <class>`, plus ` · reading…` while encoding.
   - The Apply entry's hint reads "Paints the previewed mask, or adds its box in Boxes, as the selected class."

**Out of scope:** SAM box prompts (using a drawn box as input), automatic boxes over the whole raster, a detector model, refining an existing box with SAM.

## Interfaces
- `core/smart.ts`: `maskRect(bits: Uint8Array, w: Window): Rect | null` gives the pixel-edge bounds of the 1-bits in raster coordinates, and null when there are none. `touchesWindowEdge(r: Rect, w: Window, dims): boolean`.
- `ui/smart.ts` `Deps` gains `output: () => "mask" | "box"` and `addBox: (r: Rect, value: number) => void`. `apply()` branches on `output()`.
- `ui/smartTool.ts` passes `kinds.kind()` and spec 064's box wiring.

## Acceptance criteria
1. **Unit (core):**
   - `maskRect` equals a brute-force scan on random bits over a full window and a 300 × 200 window.
   - It is null for all zeros, and it is exact for a single bit at each corner.
2. **Unit (core):** `touchesWindowEdge` is true at an inner window side and false at a window side that is the raster's edge.
3. **Unit (ui/smart, fake Segmenter as in spec 046 criterion 3, output "box"):**
   - Enter calls `addBox` once with `maskRect` of the shown bits and the selected value.
   - It pushes no `PaintOp`, and clears the prompt.
4. **Unit:**
   - With output "box", a mask touching an inner window side says the edge message.
   - A decode after Escape changes nothing, as in spec 046.
5. **Unit:** switching the output from "mask" to "box" with a mask shown keeps the prompt, and the next Enter adds a box.
6. **E2E (fake Segmenter, Boxes kind):**
   - `M`, a click and Enter add one box equal to the fake square's bounds, selected and in the selected class.
   - One Ctrl+Z removes it, and no tile is stored.
7. **E2E:**
   - In Masks, spec 046 criterion 5 still passes.
   - The `#smart-apply` checks of spec 056 criterion 4 pass in both kinds.
8. **E2E:**
   - Shift+click excludes as in Masks.
   - A right click discards the box preview, and Escape with no prompt clears the selection.
9. `npm run check` passes.
10. **Docs:** the README's Smart select paragraph says that in Boxes it adds a box. A CHANGELOG entry.
