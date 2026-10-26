# 004: Seed labels from a classified GeoTIFF or a model

**Goal:** Fill spec 003's label store on the open imagery from a classified GeoTIFF or from a model run on that imagery, so the user corrects it with the brush, exports it as a label GeoTIFF that imports back unchanged, and retrains.

**Status:** Proposed (architect, 2026-10-26), awaiting Gage. Build order: after spec 003, before spec 005 (AlphaEarth training), which uses these labels unchanged. **ADRs:** 0013 label GeoTIFF format (Proposed), which amends 0001 and fills 0010's open save format; uses 0002. External model files and GPU inference are covered by ADR 0012 (Proposed) and a later spec.

**Open questions (recommended default in brackets):**
1. Cap: a seed that needs more than 256 label tiles (about 4096 x 4096 imagery px) is refused, and whole-image class maps will often hit this. [Keep the cap in v1. An OPFS store (ADR 0010 option b), or seeding only the current view, can follow.]
2. Default "Min. confidence" for model seeding. [0: every valid pixel is labelled, as in an import.]
3. Class raster types. [Single-band 8-bit unsigned only. 16-bit comes later.]
4. mangrove-embed predictions: which values, and is GDAL_NODATA set? [Assume Uint8 classes with GDAL_NODATA set. If 255 = ignore is untagged, the user gives a class map, and unlisted values stay unlabelled.]
5. Should spec 001's classification export also write the class table, so its outputs import with names? [No. Path (b) seeds from the model directly.]
6. Merge a seed into existing labels instead of replacing them? [Replace, after a confirm.]

**Decided (Gage, 2026-10-26):** seed from a classified GeoTIFF and from our model JSON. External model files are out of this spec (ADR 0012). Outputs are a label GeoTIFF export and retraining here. The spec takes number 004 and is built right after 003.

## Scope
In: "Import labels" (a classified GeoTIFF plus an optional class-map JSON), resampled onto the imagery grid; "Seed from model" with a "Min. confidence" field; editing seeds with spec 003's brush; "Export labels" as a GeoTIFF on the imagery grid that imports back to the same labels and classes; Train as in spec 003.
Out: external model files, ONNX and GPU inference (ADR 0012); multi-band, 16-bit or float class rasters; CRSs outside ADR 0002; majority or other resampling; merging with existing labels; seeding or labelling AlphaEarth; `.aux.xml` sidecars, RATs and QGIS styles; a TIFF colour map in the export; raising `MAX_LABEL_TILES`; undo.

## Interfaces (`core/`)
```ts
const CLASS_ITEM = "GEOAPP_CLASSES"; // GDAL_METADATA dataset item (ADR 0013)
type ClassEntry = { value: number; name: string; colour?: string }; // value: source pixel value 0..255; colour "#rrggbb"
seedWindows(dst: Grid, src: Grid): Window[] // dst tileWindows with a pixel centre on src; row-major; may over-include, never misses
sourceCells(dst: Grid, src: Grid, w: Window): Int32Array // per pixel of w, row-major: col, row of the src pixel holding its centre, or -1, -1
gatherCells(cells: Int32Array, sw: Window, data: Uint8Array, out: Int16Array): void // out[i] = data at cell i when inside src window sw; else untouched (caller fills -1)
markValues(vals: Int16Array, seen: Uint8Array): void            // seen (256 entries)[v] = 1 for every v >= 0
classesFromValues(seen: Uint8Array, nodata: number | null): ClassEntry[] // ascending values, nodata skipped, name "Class v"
parseClasses(json: unknown, nodata: number | null): ClassEntry[] // throws Error naming the bad field
seedLut(entries: ClassEntry[]): Uint8Array                      // 256 entries: value -> entry index + 1; unlisted -> 0
applyLut(vals: Int16Array, lut: Uint8Array): Uint8Array         // -1 -> 0
seedFromModel(model: Model, tile: Tile, minProb: number): Uint8Array // argmax index + 1 where max softmax >= minProb, else 0; nodata -> 0
putTile(store: LabelStore, w: Window, labels: Uint8Array): "ok" | "full" // replaces w's tile; all-zero deletes it; "full" changes nothing
encodeClasses(classes: LabelClass[]): string // `<GDALMetadata><Item name="GEOAPP_CLASSES">` + XML-escaped JSON ClassEntry[] (value = index + 1)
decodeClasses(inner: string): unknown       // unescapes &amp; &lt; &gt; &quot; &apos;, then JSON.parse; throws on bad JSON
```
**Rules.**
- **Import labels.** Enabled while local imagery is open. The user picks a GeoTIFF and, optionally, a class-map JSON (a `ClassEntry[]`). A file that isn't single-band with 8-bit unsigned samples is refused with "Label files must be single-band 8-bit GeoTIFFs." (this also refuses AlphaEarth files). Its CRS and extent must pass spec 001's checks for opening a raster, with the same messages. `nodata` is the file's GDAL_NODATA when that is an integer from 0 to 255, else null.
- **Classes.** The table comes from the class-map JSON if one is given, else the file's `CLASS_ITEM` (`decodeClasses` of geotiff.js `getGDALMetadata()[CLASS_ITEM]`), else `classesFromValues` of the values at the sampled cells, collected in a first pass. Tables pass through `parseClasses`, which applies spec 003's name rule and rejects 0 or more than 255 entries, duplicate values and the nodata value. On error ui shows "The class table is invalid: <field>." The list keeps the table's order, a label's value is its index + 1, and each colour comes from the entry, else from spec 003's palette by position. Nodata values, unlisted values and pixels whose centre is off the file stay unlabelled. Names are edited afterwards in spec 003's list; there's no prompt.
- **Resampling.** Nearest pixel centre: imagery pixel (c, r)'s centre (c + 0.5, r + 0.5) goes through the imagery's gt, `core/crs` and the inverse of the file's gt, and is floored. This is spec 005's transfer at k = 1. Imagery nodata isn't checked here, because training skips it (spec 003).
- **Tiling.** Seeding visits each window of `seedWindows(imagery, file)` once per pass (two passes when classes come from values). `io/` reads only the file's 256x256 windows, aligned to the file's own grid, that hold one of that window's cells. It reads them one at a time and reads no imagery window.
- **Seed from model.** Enabled while local imagery is open and a model exists: trained, or loaded and validated as in spec 001 against the imagery's band count (spec 005 later adds the "imagery" source check). "Min. confidence" is a number field from 0 to 1, step 0.05, default 0. A value outside 0..1 disables the button and shows "Min. confidence must be between 0 and 1." Seeding reads every imagery window once and applies `seedFromModel`, which uses `predictTile`'s logits and argmax (first maximum). The list becomes `model.classes`, coloured from the palette.
- **Replace.** Both paths build a new store and list, and swap them in only when seeding succeeds. If any pixel is labelled, `confirm("Replace labels?")` comes first, and Cancel changes nothing. When `putTile` returns `"full"`, seeding stops, nothing changes, and ui shows "Label limit reached (256 tiles of 256 x 256 px). Nothing was seeded." When no pixel gets a label, ui shows "No labels to seed here." and nothing changes. On success ui shows "Seeded N pixels in K classes."
- **Edit and retrain.** Seeded labels are ordinary spec 003 labels. The brush paints and erases them, Train trains on them, and spec 005 transfers them, all unchanged.
- **Export labels.** Enabled while local imagery is open. ADR 0001's writer writes the imagery's whole grid: tags copied from the imagery, 256x256 tiles (each the stored tile, or zeros), GDAL_NODATA "0", and GDAL_METADATA `encodeClasses(list)` listing every class, used or not. Value 255 (the 255th class) is therefore a class, not nodata. Spec 001's classification export is unchanged: classes 0..254, GDAL_NODATA "255". Export reads no imagery window, and spec 001's size limit applies.
- **Saving labels.** Export labels and Import labels take the place of spec 003's deferred save and load. An exported file imports back to the same store and class list. Between the two steps, labels still live only in memory.
- **Test data.** Small class rasters (under 100 KB) over spec 001's EPSG:4326 fixture, in EPSG:32633: values 0, 3, 7 and 255 with GDAL_NODATA 255; the same without GDAL_NODATA; one with `CLASS_ITEM`; a class map; and 3-band and 16-bit files for the refusals. Larger rasters are generated in memory by tests.

## Acceptance criteria
1. `sourceCells`: on equal grids, every pixel maps to itself. With an EPSG:4326 dst and an EPSG:32633 src, the points in `tests/fixtures/crs-points.json` give the floor of their recorded src coordinates, skipping points within 0.01 px of an edge. Pixels off src give -1, -1.
2. `seedWindows`: checked by brute force over every window of a 3x3-window dst, it holds each window with a cell on a src in another CRS. A disjoint src gives [].
3. `parseClasses` accepts a valid table. It rejects each of the following, naming the field: a non-array; 0 or 256 entries; a value that isn't an integer, is outside 0..255, is duplicated or equals nodata; a name that is empty, duplicated or not a string; a colour that isn't "#rrggbb".
4. With values {0, 3, 7} present and nodata 255, `classesFromValues` gives "Class 0", "Class 3", "Class 7", and `seedLut` maps 0 -> 1, 3 -> 2, 7 -> 3 and everything else to 0. `applyLut` maps -1 to 0.
5. `seedFromModel` on spec 001 criterion 7's tile and model: at minProb 0 it equals `predictTile` + 1, with 255 -> 0. At minProb 0.9, pixels whose max softmax is below 0.9 are 0 and all other pixels keep their minProb 0 value.
6. `putTile` replaces a tile, deletes it when given all zeros, and at `MAX_LABEL_TILES` returns `"full"` for a new key (store unchanged) but still replaces an existing key.
7. `encodeClasses` then `decodeClasses` round-trips names containing `<`, `>`, `&`, `"`, `'` and non-ASCII text. On a written file, geotiff.js `getGDALMetadata()` returns exactly one dataset item named `GEOAPP_CLASSES`.
8. Export (EPSG:4326 fixture): geotiff.js reads back the imagery's width, height, origin, resolution and GeoKeys, with 256x256 tiles and GDAL_NODATA "0". Pixels equal the store, and 0 where no tile is stored. With 255 classes, a pixel of class 255 reads back as 255 and imports as class 255. Export reads no imagery window (instrumented source).
9. Round trip (e2e): paint three classes, rename one to `Mangrove & <salt>`, recolour one and add an unused class. Export, open the imagery again and accept spec 003's discard confirm (the store is now empty), then import the export. Every tile is byte-equal per key, and the class list (names, colours, order, including the unused class) is identical.
10. Classes (e2e): the `CLASS_ITEM` file takes its names and colours from the item. The same file with a class map takes the map's names, and its unlisted values stay unlabelled. The 0/3/7 file gives "Class 0", "Class 3", "Class 7"; without GDAL_NODATA, 255 becomes a class too. An invalid class map shows the message and changes nothing.
11. Resampling (io, fixtures): each seeded pixel equals `seedLut` of the file value at `sourceCells` of that pixel, checked by brute force.
12. Reads (instrumented file and imagery sources): import reads no imagery window. Every file read is a 256x256-aligned window of at most 256x256 that holds a cell of the current imagery window, read at most once per imagery window per pass. Model seeding reads each imagery window exactly once.
13. Refusals (e2e): the 3-band file, the 16-bit file and a spec 002 fixture (a) AlphaEarth COG show "Label files must be single-band 8-bit GeoTIFFs.", and an unsupported CRS shows spec 001's message. A file that doesn't overlap the imagery shows "No labels to seed here." Nothing changes in any of these cases.
14. Replace and cap: with labels painted (e2e), import shows the confirm. Cancel keeps the labels and classes, and OK replaces them. Seeding a 4352x4352 class raster generated in memory onto an equal 4352x4352 grid (io) stops with `"full"` and leaves the store and list unchanged, and ui maps `"full"` to the limit message (unit).
15. Seed from model (e2e, EPSG:4326 fixture): Seed is disabled until a model exists. After training on two painted classes, seeding at 0 gives tiles equal to `seedFromModel` on every window, and the list equals `model.classes`. At 0.9 only pixels whose max softmax is at least 0.9 are labelled. A value of 1.5 shows the message and disables Seed.
16. Edit and retrain (e2e): after an import, a right drag clears the selected class in a seeded area, and a left drag paints. Train then meets spec 003 criterion 15 (N = labelled pixels, `model.classes` = list).
17. Privacy (request log): importing, seeding and exporting labels make no network requests.
