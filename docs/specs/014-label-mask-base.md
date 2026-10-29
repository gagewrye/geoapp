# 014: Fine-tune an imported label mask of any size

**Goal:** Import a label mask covering any part of the imagery, however large, edit it with the brush, undo those edits back to the mask, and export the result. Nothing ever holds the whole mask or imagery in memory.

**Status:** Approved (Gage, 2026-10-28). Build after spec 013, which shelves Train and model seeding, so nothing else reads the label store. **ADRs:** 0018 mask base plus sparse edits (Accepted; amends 0010 and 0015). Uses 0002 and 0013.

**Already built (spec 004 Import labels, ADR 0013), unchanged here:**
- Formats: a single-band 8-bit unsigned GeoTIFF or COG. Anything else gets "Label files must be single-band 8-bit GeoTIFFs."
- CRS: any ADR 0002 CRS, resampled onto the imagery grid by nearest pixel centre. On an equal grid this is the identity.
- Classes: values map to classes through a Class map JSON, else the file's `GEOAPP_CLASSES`, else "Class v" per value.
- Nodata: the file's GDAL_NODATA stays unlabelled, and imagery nodata is never labelled.
- Merge or Replace; reads are 256x256 windows, one at a time; export round-trips byte for byte.

**The gap:** imports write into the 256-tile in-memory store (ADR 0010). A dense mask over more than 256 tiles (more than about a 4096 x 4096 px area) stops with "Label limit reached", so most real masks can't be loaded.

**Decided (Gage, 2026-10-28):** "There will be masks larger than 4096." Accepted: the mask shows at preview resolution (at most 1024 px across the raster, like the imagery) and at full resolution only on painted tiles; Merge while a mask is loaded is refused; GeoTIFF only for now; an import itself is not undoable (spec 010 clears history on import). Spec 004's untagged-file rule stays as shipped ("accept all except value 0"): with no GDAL_NODATA, 0 imports as "Class 0", and a class map may name 0.

Because every import is a mask here, the same holds for masks (Gage accepted this, 2026-10-28): an untagged mask's 0 is "Class 0", with no "0 is unlabelled" option. The user can clear it with the brush, or use a class map that leaves 0 out.

## Scope
**In:** the mask as a read-only base under sparse edit tiles; its preview layer; copy-on-touch for the brush; export of base plus edits; Merge with no base loaded.

**Out:** a "0 is unlabelled" rule or option for untagged files; stacked masks (Merge onto a loaded mask); PNG, 16-bit and un-georeferenced masks (later); undoing an import; a full-resolution display of unedited tiles; more than one base.

## Interfaces (`core/`)
```ts
type LabelStore = { width: number; height: number; tiles: Map<string, Uint8Array>; base: boolean };
  // base: a mask is loaded; a key absent from tiles shows the mask there, and tiles override it whole;
  // with base, emptied or all-zero tiles are kept (they hide the mask); emptyStore gives base false
brush(...)   // signature unchanged; erase deletes an emptied tile only when !store.base
putTile(...) // signature unchanged; all zeros deletes the tile only when !store.base
previewCells(grid: Grid, maxSide: number): { cells: Int32Array; width: number; height: number; corners: [number, number][] }
  // per preview pixel, row-major: col, row of the raster pixel holding its centre, or -1, -1;
  // axis-aligned Mercator grid fitted to the raster, longest side maxSide; corners lon/lat TL, TR, BR, BL
paintPreview(values: Uint8Array, hidden: Uint8Array, colours: string[], rgba: Uint8ClampedArray): void
  // colours[v - 1] at alpha 255 where values[i] = v > 0 and hidden[i] = 0; else alpha 0
```
`io/` holds the base: the `LabelSource`, its `seedLut`, and its labelled-pixel count. Its tile for window w is spec 004's per-window import step: `applyLut` of the gathered file values, then `maskNodata` with the imagery window if any value is non-zero.

**Rules.**
- **Import labels** keeps spec 004's checks, class table, resampling and reads (criterion 14). It no longer copies labels into tiles; the file becomes the base.
  - `openLabelTiff`, `parseClasses` and `classesFromValues` are unchanged, so a file's classes are exactly spec 004's.
  - The labelling pass counts N and K and fills the preview values (`previewCells`, `PREVIEW_MAX_SIDE` 1024) window by window.
  - **Replace:** the new base, an empty `tiles` with `base: true`, and `mergeClasses([], incoming)`.
  - **Merge**, only while no base is loaded: each stored tile becomes `mergeTile(tile, baseTile)`, read once each. Classes are `mergeClasses(list, incoming)`, and N counts only pixels that were unlabelled before.
  - **Merge while a base is loaded** changes nothing and shows "Merge works only while no mask is loaded. Use Replace."
  - A successful import calls spec 010's `replace()`, which clears the history. Opening a raster drops the base.
- **Copy on touch.** spec 003's mask read for a key absent from `tiles` also yields its base tile, from the same imagery window plus the file windows. The base tile is held with the mask until the key's next cell applies (at most one per held mask). At that apply, after `recordTiles` has recorded the key as null, `io/` stores the base tile if it is non-zero, then runs `brush`.
  - This applies to paint and erase alike. Hover still reads nothing.
  - If storing a tile would pass `MAX_LABEL_TILES`, the cell changes nothing and ui shows "Label limit reached (256 edited tiles of 256 x 256 px). Undo strokes, or export the labels and import the export with Replace."
  - Undo deletes a null-recorded tile, so the mask shows again and the space is freed.
- **Display.** The base is one canvas image source with nearest resampling and `raster-opacity` 0.6, layer and source id `mask`, in a new slot `mask` between the imagery preview and the label overlays. The id must not start with `label-`, which `beforeSlot` and existing tests treat as an overlay.
  - Preview pixels whose cell lies in a key present in `tiles` are hidden, so that tile's full-resolution overlay (ADR 0016) alone shows there.
  - It repaints when a key is added to or removed from `tiles`, and on recolour.
- **Export labels** writes, for each window, the stored tile, else the base tile, else zeros. It reads files only for base windows with no stored tile.
- **The mask file** is read for the whole session; nothing copies it. A read can fail because the file changed (`NotReadableError`) or is gone (`NotFoundError`), per the W3C File API. Then the cell or the export changes nothing, and ui shows "The label mask can't be read any more. Import it again."
- `hasLabels` is true when `tiles` is non-empty or the base count is above 0. This drives the discard confirm and Seed mode. The e2e hook `__geoapp.labels` gains `tile(key): Promise<Uint8Array | null>`, the effective tile.

## Acceptance criteria
1. `previewCells` (unit, spec 003's EPSG:32633 fixture grid): each cell equals, by brute force, the floor of the inverse geotransform of its preview pixel centre; off-raster cells are -1, -1; the corners form a Mercator rectangle; the longest side equals maxSide.
2. `paintPreview` (unit): class colours at alpha 255; alpha 0 for value 0 and for hidden pixels.
3. Base flag (unit): with `base: true`, an erase that empties a tile and a `putTile` of zeros both keep the tile. With `base: false`, spec 003 criterion 4 and spec 004 criterion 8 hold unchanged.
4. Large mask (io, instrumented sources): an 8192 x 8192 fully labelled mask generated in memory on an equal-grid imagery (1024 tiles) imports with Replace without "full".
   - `tiles` is empty, and N equals the labelled pixels that aren't imagery nodata.
   - Every read is a 256x256-aligned window of at most 256x256, each file window once and each imagery window at most once, with at most one read outstanding per source.
5. Effective labels (io, brute force, spec 004's fixtures and generated nodata imagery): after an import, `tile(key)` of every window equals `seedLut` of the file value at `sourceCells`, and 0 at imagery nodata. This is spec 004 criterion 13, now on effective tiles.
6. Fine-tune (e2e, EPSG:4326 fixture plus a generated mask):
   - A size-7 paint stroke across a base tile corner gives the stroke's pixels the selected class; every other pixel of the 4 touched tiles keeps its base value; `tiles` has exactly those keys.
   - A right drag clears only the selected class, mask pixels included.
7. Undo (e2e): after criterion 6, Undo twice: every `tile(key)` equals its post-import value, `tiles` is empty and Undo is disabled. Spec 010 criterion 5's import clauses hold.
8. Cap (io): with 256 stored tiles and a base, a cell touching a 257th base tile shows the message and changes no tile; after one Undo that frees a tile, the same cell applies.
9. Round trip (e2e): import, paint, erase, rename and recolour. Export, reopen the imagery (OK on the discard confirm), and import the export with Replace. Every window's `tile(key)` is byte-equal to before the export, and the class list is identical. On the export (io), the file equals the effective tiles, and stored windows read no file or imagery window.
10. Merge (e2e): with painted tiles and no base, a Merge import keeps every painted pixel and fills the unlabelled ones from the mask; the effective tiles equal spec 004's Merge result on the same inputs. With a base loaded, Merge shows the message and changes nothing, while Replace still works.
11. Display (e2e, basemap hidden through the hook):
    - At a labelled mask pixel, the rendered colour is the class colour blended at 0.6.
    - After painting another class over that pixel's tile, pixels in the tile show only overlay colours.
    - After Undo, the mask colour returns. Recolouring a class changes the mask preview's colour.
12. File gone (io): a mask source whose read rejects with `NotReadableError` makes a copy-on-touch cell and an export fail with the message, with the store and classes unchanged.
13. Opening another raster (OK on the confirm) leaves `hasLabels` false and no `mask` layer. Importing, painting and exporting make no network requests.
14. Classes unchanged (e2e): spec 004 criterion 12 passes as shipped, now with the file as a base; in particular the 0/3/7/255 file without GDAL_NODATA gives "Class 0", "Class 3", "Class 7", "Class 255", and its value-0 pixels show the "Class 0" colour.
