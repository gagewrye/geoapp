# 045: Background flicker, and spec 039 follow-ups

**Status:** Draft, 2026-10-31. Gage asked for this scope; this spec awaits his approval. **ADRs:** none, unless open question 2 turns out to be the cause. **Builds on specs 012, 020, 037 and 039, and ADRs 0014 and 0019.** Checked against maplibre-gl 6.16.0 (`node_modules/maplibre-gl/src`).

**Open questions (Gage):**
1. Which "background" flickers: the basemap around the raster, or the imagery under the labels? Does it flicker with no raster open? A short screen capture would settle it.
2. If candidate A below is the cause, the fix needs mipmaps that MapLibre doesn't offer for image and canvas sources, or a basemap pyramid. Either one needs an ADR and a follow-up spec.

**Goal:** Zooming and tilting no longer flicker, and the shortcut list from spec 039 behaves on held keys and on macOS.

## Causes found (not yet confirmed in a browser), most likely first
- **A. Minification shimmer.** MapLibre gives image and canvas sources no mipmaps (`image_source.ts:474`), and falls back to a LINEAR min filter (`texture.ts:159-162`). This affects the 2048² basemap (`map/style.ts:15`) and the full-resolution tiles (`map/imagery.ts:51-53`). Those tiles are only replanned once the map settles (`ui/imagery.ts:35-39`), so mid-zoom-out and on the far side of a tilt they are drawn at more than 2× minification and sparkle. This fits "zooming and tilting".
- **B. Basemap fade.** `basemap` (`map/style.ts:19`) is the only raster layer without `"raster-fade-duration": 0`. MapLibre fades image sources as raster tiles (`tile_manager_raster.ts:8-10`, `tile_manager.ts:598-601`): a basemap tile that is re-added fades in from `BACKGROUND` over 300 ms. MapLibre's own doc at `image_source.ts:285-286` gives this fix.
- **C. Seams between imagery quads.** Each canvas source rounds its corners to its own tile grid (`image_source.ts:440, 453`), so neighbouring quads' edges need not meet. Hairline gaps then show the preview or basemap, and they crawl while the map moves.
- **D. Globe-to-Mercator switch** (z10-12): meshes change from the globe's tile meshes to quad meshes (`image_source.ts:338`). That would be a single pop at one zoom, not a continuous flicker.

The app itself removes no layer or source while the map moves. `ImageryLayer.draw` swaps a tile in one task, only after moveend.

## Scope
1. **Probe.** An e2e test steps the camera with `jumpTo`, 16 ms apart:
   - zoom +2 in 60 frames, then pitch 0→60° in 60 frames;
   - once with no raster, and once with the fixture raster open;
   - on each `render` event, it reads a 5×5 patch at 9 fixed screen points with `gl.readPixels`;
   - per run it reports **bg-hits** (sampled pixels within ±4 of `BACKGROUND` at points over the basemap or imagery) and **shimmer** (mean |2pᵢ − pᵢ₋₁ − pᵢ₊₁| over the patches).
   - It records the baseline on main (c8076f7) in the change.
2. Fix B: give `basemap` `"raster-fade-duration": 0`.
3. If shimmer doesn't meet criterion 3 after fix B, the implementer stops and returns the probe numbers to the architect (open question 2). Candidates C and D are fixed only once the probe points at them.
4. Holding `?` doesn't flicker the dialog: a keydown with `e.repeat` that would toggle it is swallowed (`stopPropagation`, `preventDefault`) and neither opens nor closes it (`ui/help.ts:37-45`).
5. Mac modifiers. Undo and redo are written `Mod+Z` and `Mod+Shift+Z`. `keyLabel` shows `Mod` as `Cmd` on Mac and `Ctrl` elsewhere, and `ariaKey` writes it as `Meta` or `Control`. `Ctrl+Y` stays Ctrl. One `IS_MAC` replaces `ui/undo.ts:35`.
6. **Stable ids.** `Shortcut` gains an `id`, such as `paint` or `peek`. `KEYMAP` maps to ids, and `actionOf` returns an id. `labelKeys` and `help` branch on ids, never on `action` text (`ui/labelKeys.ts:32-38, 66-75`; `ui/help.ts:38`).
7. On Mac, Ctrl+Shift+Z redoes too, alongside Cmd+Shift+Z and Ctrl+Y. macOS and the browsers bind no action to it. Mac Ctrl+Z stays unbound, as now.

**Out of scope:** remapping keys, antialiasing, changing ADR 0019's quad geometry.

## Interfaces
- `ui/shortcuts.ts`:
  - `type Shortcut = { id: string; section: string; keys: string[]; action: string; button?: string }`;
  - `IS_MAC: boolean`;
  - `keyLabel(k: string, mac = IS_MAC)` and `ariaKey(k: string, mac = IS_MAC)`.
- `ui/labelKeys.ts`: `KEYMAP: Record<string, string>` maps keys to ids, and `actionOf(e): string | undefined` returns an id.
- No `core/` change.

## Acceptance criteria
1. **Unit:** `baseStyle()`'s `basemap` layer has `raster-fade-duration` 0.
2. **E2E (probe):** bg-hits is 0 in both runs.
3. **E2E (probe):** in both runs, shimmer is at most half of main's baseline. If it isn't, see scope 3.
4. **Unit (help):** with `#help` closed, a `?` keydown with `repeat: true` leaves it closed; with it open, the same keydown leaves it open and reaches no other listener.
5. **Unit:**
   - `keyLabel("Mod+Z", true)` is `Cmd+Z` and `keyLabel("Mod+Z", false)` is `Ctrl+Z`;
   - `ariaKey("Mod+Shift+Z", true)` is `Meta+Shift+Z` and `ariaKey("Mod+Shift+Z", false)` is `Control+Shift+Z`;
   - `keyLabel("Ctrl+Y", true)` is `Ctrl+Y`.
6. **Unit:**
   - every `SHORTCUTS` id is unique, and every `KEYMAP` value is one of them;
   - `src/ui/labelKeys.ts` and `src/ui/help.ts` contain no string literal equal to any `action`.
7. **Unit (undo keys, Mac):** Meta+Shift+Z, Ctrl+Shift+Z and Ctrl+Y call redo, and Ctrl+Z calls nothing. Spec 037's criterion 5 still passes off Mac.
8. Spec 039's criteria pass, with titles such as `Undo (Ctrl+Z)` off Mac. `npm run check` passes.
