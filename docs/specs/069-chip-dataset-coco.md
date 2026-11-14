# 069: Export a detection dataset: image chips with COCO annotations

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** 0039 (Accepted: a chosen folder, PNG chips). **Builds on specs 004, 019, 046 (the displayed-colour read), 064 and 068.** It is part of the series in spec 062. Spec 070 adds YOLO files to the same export.

## Why chips
A detector trainer (Ultralytics YOLO, or a COCO-format tool) takes many small images and resizes each to its input size, about 640–1024 px. A whole orthomosaic would shrink every object to nothing, and it doesn't fit in memory. So the trainer needs:
- chips cut at native resolution;
- each box in chip pixels;
- every object in a chip boxed, since an unboxed object teaches "background".

Georeference is optional: chip offsets let predictions be mapped back.

## Decided (Gage, 2026-11-12: the recommended answers)
1. **Chip pixels.** 8-bit RGB in the displayed colours (ADR 0039), not GeoTIFF chips of the raw bands.
2. **Defaults.** Size 640, overlap 128, and a box cut by a chip edge kept when at least 50% of its area is inside.
3. **Which chips.** Only chips that keep at least one box. Chips with no box (negative examples) are out of scope.
4. **No train/val split.** The user splits the dataset. Spec 070's `data.yaml` points `train` and `val` at the same images.
5. **README rule.** It says every object in an exported chip must be boxed (criterion 10).

**Goal:** Export dataset writes PNG chips of the boxed areas, and a COCO `annotations.json` of their boxes, into a new folder, reading the raster tile by tile.

## Scope
1. **Button and form.**
   - `#export-dataset` (Export dataset) sits after `#export-boxes`, with spec 068's visibility and disabled rules. Without `showDirectoryPicker`, it is disabled and titled `Export dataset needs Chrome or Edge.`
   - Clicking it opens `<dialog id="dataset">` with these fields:
     - chip size: 64–2048, default 640;
     - overlap: 0 to size/2, default 128;
     - minimum visible share: 10–100%, default 50.
   - The values persist in `localStorage` (`geoplatform.dataset`). A storage failure is ignored.
   - **Export** calls `showDirectoryPicker({ mode: "readwrite", startIn: folder })` within the click. `startIn` is only passed when the imagery handle is held (spec 050). Cancel, or `AbortError`, does nothing.
2. **Grid.**
   - Along each axis the origins are `0, s, 2s, …` with `s = size − overlap`. The last origin is clamped to `length − size`, and duplicates are dropped.
   - An axis shorter than the size gives one chip of the axis's length.
   - Every chip lies inside the raster, and none is padded.
3. **Boxes in a chip.**
   - A box is kept when its intersection with the chip has at least `minVisible` of its area. It is clipped to the chip, in chip pixels.
   - Chips with no kept box are skipped.
   - The finished message counts any box kept in no chip: `<n> boxes are in no chip; raise the overlap or the chip size.`
4. **Pixels.**
   - Each chip is read as 256 × 256 `readSamples` calls of `displaySamples` bands, one at a time, then mapped with `toRgba` and the preview's ranges (the spec 046 path, shared with `io/samImagery.ts`).
   - Nodata and alpha-0 pixels are black. The PNG is opaque (alpha 255 everywhere), from `OffscreenCanvas.convertToBlob({ type: "image/png" })`.
   - At most one chip is held at a time.
5. **Files.** In a new subfolder `<raster stem>_dataset` (or `_dataset_2`, `_3`… when it already exists):
   - `images/<stem>_<x0>_<y0>.png`;
   - `annotations.json`, written last, as COCO:
     - `info`: description, raster name, `date_created`, chip size, overlap, `min_visible`, bands and `ranges`;
     - `images`: `{ id, file_name, width, height, x0, y0 }`, where `x0` and `y0` are the chip's raster offset;
     - `annotations`: `{ id, image_id, category_id: value, bbox: [x, y, w, h], area: w·h, iscrowd: 0 }`;
     - `categories`: every class, as `{ id: value, name }`.

     `pycocotools` `COCO()` indexes by these ids, and `COCOeval` (bbox) reads `bbox`, `area` and `iscrowd` (cocoapi source, checked 2026-11-12).
6. **Run.**
   - The export holds spec 004's lock and shows spec 019's progress, as chips done out of the total, with Cancel. Cancel stops after the current chip, and says the folder is incomplete.
   - A failure says so, and leaves behind the files written so far (ADR 0039).

**Out of scope:** empty chips, train/val split, raw-band chips, JPEG, chips from overviews, masks as COCO segmentation, Firefox and Safari.

## Interfaces
- `core/chips.ts` (pure):
  - `chipOrigins(length, size, overlap): number[]` and `chipWindows(dims, size, overlap): Window[]`;
  - `clipToChip(r: Rect, chip: Window, minVisible: number): Rect | null`, in chip pixels;
  - `planChips(boxes, dims, opts): { chip: Window; boxes: { box: Box; rect: Rect }[] }[]`.
- `core/coco.ts` (pure): `cocoJson(plan, files: string[], classes, info): string`.
- `io/rgbaWindow.ts`: `readRgba(source, w, ranges, signal): Promise<Uint8ClampedArray>`, used by both `readSamInput` and the export. `io/dataset.ts` writes the folder.
- `ui/dataset.ts` wires the form and the run.

## Acceptance criteria
1. **Unit (chipOrigins):**
   - For lengths 1–3000, sizes 64–1024 and overlaps 0 to size/2, the chips cover the axis, lie inside it, and step by at most `size − overlap`.
   - Length 1000, size 640 and overlap 128 give [0, 360].
2. **Unit (clipToChip):**
   - A box wholly inside is shifted only.
   - A box exactly 50% inside is kept at 0.5 and dropped at 0.51.
   - A box outside gives null.
3. **Unit (planChips):**
   - Chips without a kept box are absent.
   - Each box is in at least one chip, or is counted as unplaced.
4. **Unit (cocoJson):**
   - The result parses.
   - Ids are unique and start at 1, and every `image_id` and `category_id` exists.
   - Each bbox equals its clipped rect, and `area = w·h`.
5. **Unit (readRgba, fake source):**
   - It reads only 256 px pieces, none twice for one chip.
   - Nodata comes out as opaque black.
   - `readSamInput` still equals spec 046 criterion 1's reference.
6. **E2E (fake `showDirectoryPicker` backed by OPFS, fixture raster, 2 boxes):**
   - The folder holds `images/` with the planned PNGs, each decoding to its chip's size.
   - `annotations.json` matches `planChips`.
   - A second export makes `_dataset_2`.
7. **E2E:**
   - Cancel mid-run stops writing, with no `annotations.json`.
   - While the export runs, a box drag changes nothing.
   - With `showDirectoryPicker` deleted, the button is disabled with its title.
8. **Perf:** on Chunk 11, with 200 boxes, no task runs over 50 ms, and the JS heap grows by at most 64 MiB over the run.
9. **Manual (tester):** `pycocotools.coco.COCO("annotations.json")` loads the export, with its image and annotation counts. Record the Python and pycocotools versions.
10. `npm run check` passes. **Docs:**
    - The README describes Export dataset and says every object in an exported chip must be boxed.
    - CLAUDE.md's `core/` line should gain "chip grids and annotation formats". Only Gage edits CLAUDE.md.
    - A CHANGELOG entry.
