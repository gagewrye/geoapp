# Changelog

One entry per merge to main, newest first. Details are in the named spec.

## 2026-11-02
- **Spec 050:** On Chrome and Edge, Open GeoTIFF uses the browser's file picker, so Export labels opens its Save dialog in the imagery's own folder (suggesting `labels.tif`) instead of the last folder used; other browsers are unchanged (ADR 0034).
- **Spec 049:** In Smart select a right click discards the pending selection (points and preview) without leaving Smart mode, so you can start again quickly; exclude points move to Shift+click. A right drag still rotates the map, and Ctrl+Z still undoes an applied fill.

## 2026-11-01
- **Spec 048:** Painting, mask edits and smart-select fills are never refused for a tile limit, so a whole chunk can be labelled; at most 256 tiles nearest the view's centre draw at full resolution, the rest on the preview layer, and the latest edit stays undoable however large.
- **Spec 047:** Import labels never fails on a class table: bad entries in a file's table are skipped and named in the message, and values it doesn't name import as "Class N". The optional **Apply class map** now comes after Import labels and renames and recolours the loaded classes by value without touching any pixels.
- **Spec 046 Amendment A:** Smart select no longer shows low-confidence masks that flood the area: it picks the most confident mask among those with stable edges, and logs each mask's scores to the browser console.

## 2026-10-31
- **Spec 046:** Smart select (M): click points on the imagery and SAM 2.1 Tiny, running locally on WebGPU, proposes a mask to fill with the selected class; Enter applies it, Escape discards it. Fetch the model once with `npm run fetch-model`.
- **Spec 045:** The top of a zoomed, tilted map no longer flickers navy: the basemap stops drawing from zoom 12, leaving plain navy ground outside the raster. Holding ? no longer flickers the help list, macOS tooltips say Cmd, and Ctrl+Shift+Z also redoes on macOS.

## 2026-10-30
- **Spec 039:** ? or the top-bar button lists every shortcut (other shortcuts pause while it is open), buttons show their keys in tooltips, and a class pick still reading is cancelled when another raster or label file opens.
- **Spec 038:** Alt+click a pixel, or press I while hovering, to select its class without leaving the current tool; a failed read of an imported mask shows the error.
- **Spec 037:** Redo (button, Ctrl/Cmd+Shift+Z, Ctrl+Y) brings back undone strokes within the shared 32 MiB undo budget, and Home works with a checkbox focused.
- **Spec 036:** Each class row shows its key number, a colour swatch and its name; renaming takes the pencil button or a double-click (Enter saves, Esc cancels), so typing a shortcut can't change a name, and the list fills the panel and scrolls the selected class into view.
- **Spec 035:** The app is laid out in regions: file actions in a top bar, tools in a left strip, classes and label view in a right panel, and the status bar below; \ collapses both side panels (remembered), and Home or the ⌂ button zooms back to the raster.
- **Spec 034:** H shows or hides labels, and holding ` hides them only while held without changing the tool (no stroke starts during it); opening a raster mid-stroke no longer flashes a queued tool.
- **Spec 033:** B paints, E erases and P or Esc pans; a new **Erase** mode lets a left drag erase the selected class (dashed brush outline), and a key pressed mid-stroke takes effect when the stroke ends.
- **Spec 032:** A status bar along the bottom shows the cursor's lon/lat and raster pixel, the zoom, the current tool, save state, messages (errors in red) and progress with Cancel; a failed save retries every 30 s, a full disk no longer re-copies an imported mask, and opening another raster asks "Close these labels? They stay saved in this browser."
- **Spec 031:** Labels, classes and view settings are saved in this browser as you work (2 s after you stop, and at once when the tab is hidden or closed), and reopening the same raster offers to restore them, imported mask included; the page warns before closing only while something is unsaved.
- **Spec 030:** Opening a raster projects a sparse, self-checked grid of preview points instead of every pixel, with byte-identical results, so a typical chunk draws its preview in about 0.36 s (was 0.68 s) with no pause over 75 ms, and importing labels no longer has its 340 ms pause.
- **Spec 024:** Importing a label mask reads the label file once in a single pass and the imagery only where needed, without freezing the page: a typical chunk imports in about 3 s (was 69 s), Chunk 11 in 28 s (was about 21 min), the tiled 20000² chunk in 55 s (was about 10 min), and painting right after an import stays smooth.
- **Spec 028:** Loading imagery no longer freezes the page: uncompressed files read only the columns each tile needs (Chunk 11 reads 3 MB instead of 113 MB at full zoom), compressed files decode in small pieces, and drawing yields to the browser every 8 ms; a typical chunk now fills mid zoom in about 0.4 s with no pause over 50 ms.
- **Spec 029:** Tidy-ups from reviews: tiles that partly fail to project no longer fall back to slow placement, the tile-position cache is capped, opening a raster mid-pan waits for the pan to stop, and three intermittently failing tests are fixed.
- **Spec 027:** Holding W/A/S/D pans smoothly without reading the file mid-pan; full-resolution detail loads once you let go, and other bursts of map moves load once they settle.
- **Spec 026:** Imagery and label tiles are placed on the map from a sparse grid of projected points instead of every pixel corner, so filling the view at mid zoom takes about 0.7 s on a typical chunk (was 2.8 s before specs 025–026) and 1.0 s on the largest.
- **Spec 023:** Painting is much smoother: after a raster opens its valid-pixel masks are read once in the background and kept, each pointer move paints as one sweep, and label tiles near the brush are prepared while idle; a large brush on the largest chunk went from about 1.5 s lag to under 0.1 s.
- **Spec 025:** Opening a raster and loading detail read neighbouring parts of the file together, so a typical chunk now shows its preview in about 0.9 s instead of 2.7 s and full-resolution tiles in about half the time.
- **Spec 022:** Transparent pixels in an image with an alpha band now show as see-through and take no labels, and imports read the imagery a row at a time.
- **Spec 021:** Importing labels shows a progress bar with Cancel; the old labels leave the map while it runs and come back if it's cancelled, fails or finds nothing.

## 2026-10-29
- **Spec 020:** Zooming in now shows the imagery at full resolution, loaded tile by tile for the area in view, with the preview filling in until tiles arrive; memory stays bounded (about 530 MiB at worst), and if part of a file can't be read you see "Couldn't read part of this file, so some detail may be missing."
- **Spec 019:** A progress bar shows while a raster opens, Paint stays unavailable until the imagery is drawn, a file that can't be read now says so, and opening another file stops the previous one's reads.
- **Spec 016 (amended):** Clearing Show labels now switches to Pan instead of blocking the brush, and choosing Paint shows the labels again.
- **Fix (spec 018):** Painted labels now land exactly on the image pixels under the brush outline; before, the colour could spill up to a pixel outside it, in a direction that changed across the image.
- **Specs 016–017:** An Opacity slider and a Show labels checkbox control how labels are drawn; painting is blocked while labels are hidden, and opening a raster switches to Pan. The brush size is a slider from 1 to 127 px (odd sizes; −/+ and `[`/`]` halve or double it), Seed mode is gone, and every import replaces the labels after a confirm.
- **Spec 014:** You can import a label mask of any size and fine-tune it with the brush; areas you haven't painted are read from your file as needed. Imports always replace the current labels, can't be undone, and switch the map to Pan.
- **Spec 013:** AlphaEarth, training and model seeding are gone from the app; their code is kept unused in `shelf/`. The area tool is gone too.

## 2026-10-28
- **Spec 015:** A starfield shows around the globe.
- **Specs 009–012:**
  - Wheel zoom is centred on the map, and you can pan with a middle-button drag or WASD.
  - The brush cursor shows the label colour, and Undo/Ctrl+Z undo strokes.
  - Label tiles no longer show seams or strips.
  - A low-res world basemap is bundled with the app.
- **Fix:** Unit tests pass on Windows with Node 24. The AEF index script no longer overwrites a stray file on Windows.
- **Spec 004:** Import labels from a classified GeoTIFF, or seed them from a model, then export them as a label GeoTIFF that imports back unchanged. Seeding from a model is now shelved by spec 013.

## 2026-10-27
- **Spec 003:** Label local imagery with a paint brush.
- **Spec 002:** Classify with AlphaEarth embeddings. Now shelved by spec 013.

## 2026-10-26
- **Spec 001:** First classifier: logistic regression on labelled pixels. Now shelved by spec 013.
