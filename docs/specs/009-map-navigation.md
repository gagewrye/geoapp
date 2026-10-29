# 009: Centre wheel zoom, middle-button pan and smooth WASD

**Goal:** Make map navigation predictable: the wheel zooms about the map centre, a middle-button drag pans in every mode, and holding W/A/S/D pans smoothly.

**Status:** Approved (Gage, 2026-10-27; WASD smooth and continuous, pinch unchanged, middle-drag pans in every mode). **ADRs:** none (no dependency; uses maplibre-gl 6.16.0, ADR 0004). Partly shelved by spec 013 (2026-10-28), lapsed: the area tool.

## Scope
In: wheel zoom about the centre in all modes; middle-button (button 1) drag pan in Paint mode, Pan mode, with no imagery open and with the area tool active; continuous WASD panning while held; lifting the brush when the camera moves mid-stroke.
Out: changing double-click, keyboard `+`/`-`, arrow keys, pinch or navigation-control zoom; rebinding keys; speed settings; inertia after release; Shift+WASD.

## Interfaces (`core/`)
```ts
const WASD_SPEED = 600; // screen px per second, any direction
const WASD_MAX_DT = 50; // ms; a longer frame gap counts as 50, so a stalled frame never jumps
wasdStep(held: ReadonlySet<"KeyW" | "KeyA" | "KeyS" | "KeyD">, dtMs: number): [number, number]
  // screen offset [dx, dy] for one frame: unit vector of (D - A, S - W) x WASD_SPEED x min(dtMs, WASD_MAX_DT) / 1000; [0, 0] if it cancels
```
Checked in maplibre-gl 6.16.0: `MapOptions.scrollZoom` takes `{ around: "center" }` (`handler_manager.ts` passes it to `ScrollZoomHandler.enable`, which returns early when already enabled, so the option must be given at construction). Mouse pan is button 0 and rotate button 2; button 1 is unused (`mouse.ts`). The keyboard handler binds `=`/`+`, `-` and arrows only (`keyboard.ts`).

**Rules.**
- **Wheel zoom.** `createMap` passes `scrollZoom: { around: "center" }`. Nothing else enables or disables `scrollZoom`. The point at the map centre stays there; the footprint (spec 003 Hover) follows the pointer as before.
- **Middle pan.** A mouse `pointerdown` with button 1 on the map canvas, with no stroke or middle pan in progress, starts a pan: each move keeps the grabbed lon/lat under the pointer (Mercator zooms) or rotates the globe the same way MapLibre's left-drag pan does. It ends on pointerup, pointercancel, window blur or a move whose `buttons` lacks bit 4. Its `mousedown` is `preventDefault`ed on the map (no autoscroll icon on Windows) and never reaches terra-draw. The canvas shows `cursor: grabbing` while it runs. Left and right presses during a middle pan paint nothing; a middle press during a stroke is ignored.
- **WASD.** A `keydown` with `code` `KeyW`, `KeyA`, `KeyS` or `KeyD` adds it to the held set (repeats change nothing) and is `preventDefault`ed; its `keyup` removes it. While the set is non-empty, every animation frame pans the camera by `wasdStep(held, dt)` screen px with no easing (W moves the view north on screen, D east), so two keys pan diagonally at the same speed and opposite keys cancel. It works whenever the map shows, with or without imagery, in every mode, wherever focus is, except: a keydown on a focused text input, textarea, select or contenteditable (spec 003's text-field rule, plus select, where letters pick options), or with Ctrl, Meta, Alt or Shift held, is ignored, so typing and browser shortcuts keep working. All panning stops, emptying the set, on window blur, `visibilitychange` to hidden, focus entering a text field or select, or a keydown of Control, Meta, Alt or Shift; keys must then be pressed again.
- **Lift on camera move.** Any camera change (`move` event) during a stroke lifts the brush: the next position paints its own cell with no interpolation from the cell before the move. Centre zoom and WASD move the map under a still pointer, so without this a stroke would paint a line across the jump.

**Spec 003 rules changed.** Modes: "wheel ... work unchanged" becomes "the wheel zooms about the centre". Strokes: "other buttons ... are ignored" becomes "button 1 pans (spec 009); other buttons are ignored", and a camera move lifts the brush. The tester e2e "a middle-button drag in Paint mode paints nothing and leaves the view" (`tests/e2e/brush-input.tester.spec.ts`) is replaced by criterion 2. Spec 003 criteria 10 and 12 still hold; the handler matrix is unchanged (no handler is newly enabled or disabled).

## Acceptance criteria
1. Wheel (e2e, zoom 14, EPSG:4326 fixture): five wheel-up events at a point 200 px right and 100 px below the centre raise the zoom and leave `getCenter()` within 1e-7° of its start, in Paint mode, Pan mode and with no raster open. Nothing paints.
2. Middle pan (e2e, zoom 14): in Paint mode and in Pan mode, a middle drag of (150, 80) px leaves the lon/lat under the press point under the release point within 1 px; the store is unchanged; bearing and pitch are unchanged. At zoom 3 (globe) a rightward middle drag lowers the centre longitude. The same holds with no raster open and with the area tool active, where no rectangle is started or finished.
3. Middle details (e2e): the map's `mousedown` with button 1 is `defaultPrevented`; the canvas cursor is `grabbing` during the drag and back afterwards. A middle press during a left stroke neither pans nor ends the stroke; a left press during a middle pan paints nothing. Release over the panel, pointercancel or a `buttons: 0` move (CDP) ends the pan; later moves don't pan.
4. `wasdStep` (unit): W at dt 16 gives [0, -9.6]; D gives [9.6, 0]; W+D gives a vector of length 9.6 at 45°; W+S and A+D give [0, 0]; W+A+S gives A's step; dt 200 gives the same as dt 50.
5. WASD hold (e2e, zoom 14): holding `KeyW` for 500 ms moves the point that was at the centre down the screen by 150 to 450 px, through at least 10 distinct centres sampled every 25 ms (continuous, not stepped), with bearing, pitch and zoom unchanged; after keyup the centre doesn't change over the next 300 ms. Holding `KeyW` and `KeyD` moves it down and left by equal amounts within 10%. The same holds with focus on the "+" button and with no raster open.
6. WASD stops and ignores (e2e): window blur during a hold, and pressing Shift during a hold, stop the panning (centre unchanged over the next 300 ms while the key stays down). With focus in a class name field or a select, or with Ctrl, Alt or Meta held, holding `KeyW` doesn't move the map, and the text field receives the letter.
7. Lift (e2e, zoom 14, Paint, size 1): press left at cell p, move to cell q, wheel up once (wait for idle), move to the cell r now under a new point, release. The labelled pixels are exactly `strokeCells(p, q)` plus r. The same holds with a 200 ms `KeyD` hold in place of the wheel.
