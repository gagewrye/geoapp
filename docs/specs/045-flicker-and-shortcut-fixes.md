# 045: Background flicker, and spec 039 follow-ups

**Status:** Approved by Gage 2026-10-31. Scopes 1-3, criteria 2-3 and the causes were revised the same day after Gage's report. Gage accepted the revision, with navy ground above z12, on 2026-10-31. **ADRs:** none. **Builds on specs 012, 020, 037 and 039, and ADRs 0014 and 0019.** **Amends spec 012's criterion 3:** the basemap is hidden from `BASEMAP_MAXZOOM` up, so the "zoom 12 Mercator" placement check runs at `BASEMAP_MAXZOOM − 0.1` (z11.9 at the draft value). That is the end of the z11-12 globe-to-Mercator morph (ADR 0004), not pure Mercator: no pure-Mercator zoom shows the basemap any more. Checked against maplibre-gl 6.16.0 (`node_modules/maplibre-gl/src`).

**Decided by Gage (2026-10-31), as drafted:**
1. Above `BASEMAP_MAXZOOM` (draft 12), the ground outside the raster becomes plain dark navy `BACKGROUND` instead of the blurred basemap. At z12 and above the basemap is only a few blurred pixels. The alternative is to re-tile the basemap as a raster source through `addProtocol`, which amends ADR 0014 and needs a new ADR. Draft: the former.

**Goal:** Zooming, panning and tilting no longer flicker, and the shortcut list from spec 039 behaves on held keys and on macOS.

## Cause (Gage's screenshot, 2026-10-31: z15.7, slightly pitched)
The ~35 px band across the top is dark navy, which is `BACKGROUND` (`#1d2b3a`, `map/style.ts:6`). The light blue-grey below it is the basemap: Natural Earth ocean, magnified (`map/style.ts:15`). The band is therefore the `background` layer showing where the basemap failed to draw. It is not sky, and not the CSS behind the canvas: the sky is transparent by default (`sky.ts:30-36`), and `#map` is `#03050a` (`ui/style.css:65`).

The basemap is one image source covering the whole world. MapLibre gives it a single z0 tile (`image_source.ts:440, 449`) and draws it as one world-sized quad (`draw_raster.ts:62-64`). The background, by contrast, is drawn on z15 covering tiles (`draw_background.ts:37, 46-66`). At z15.7 that quad spans about 2^15.7 × 512 px. With pitch, its far part, the top of the screen, sits near the far plane, where float32 vertex and depth precision run out. There the basemap is clipped or fails the depth test against the background beneath it (`draw_raster.ts:107-108`), and the result changes as the camera moves. So the band flips between basemap and `BACKGROUND` when panning, zooming or tilting.

The browser has not confirmed this; scope 1 does. Ruled out:
- the canvas clear and alpha, since every frame is fully redrawn (`painter.ts:311`);
- `preserveDrawingBuffer` and canvas resizing;
- app code, since nothing is removed while the map moves.

The basemap fade fix (d17fdc6) stays, because MapLibre advises it (`image_source.ts:285-286`).

## Scope
1. **Probe.** An e2e test at 1280×720 takes page screenshots clipped to the top 60 px of `#map`, so they show what was composited, transparent pixels included.
   - Three runs, each with the fixture raster open, at z15.7 / pitch 30, z11.9 / pitch 30, and z9 / pitch 45.
   - Each run pans north by 2 px per frame for 60 frames, then zooms +0.5 and pitches +15° in 30 frames each, with a `jumpTo` and a `render` wait per frame.
   - It reports **pops**: the share of band pixels that are within ±8 of `BACKGROUND` in frame i and differ from it by more than 40 in frames i−1 and i+1, or the reverse.
   - It records the numbers on main (c8076f7) in the change.
2. Basemap fade: `"raster-fade-duration": 0` (done, d17fdc6).
3. **Fix.** The `basemap` layer gets `maxzoom: BASEMAP_MAXZOOM`, a constant in `map/style.ts`, draft 12. Above it, the ground outside the raster is uniformly `BACKGROUND`, so nothing can flip.
   - If the z11.9 run still pops, lower the constant until it doesn't, down to 10.
   - If no run on main pops, the cause is wrong: stop and return the numbers to the architect.
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
- `map/style.ts`: `BASEMAP_MAXZOOM: number`, used as the `basemap` layer's `maxzoom`.
- No `core/` change.

## Acceptance criteria
1. **Unit:** `baseStyle()`'s `basemap` layer has `raster-fade-duration` 0.
2. **E2E (probe):**
   - on main, pops is above 0.5% in the z15.7 run (this confirms the cause; see scope 3);
   - after the fix, pops is at most 0.05% in every run.
3. **Unit:** `baseStyle()`'s `basemap` layer has `maxzoom` equal to `BASEMAP_MAXZOOM`. **E2E:** spec 012's criterion 2 still passes, and at z9 a pixel over land outside the raster is not `BACKGROUND`. At z15.7 / pitch 30 with no raster, the probe band is uniformly `BACKGROUND` (±8) in every frame.
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
