# 070: YOLO labels in the exported dataset

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** 0039 (Accepted). **Builds on spec 069.** It is part of the series in spec 062.

## Decided (Gage, 2026-11-12: the recommended answers)
1. **One export.** Export dataset always writes both COCO and YOLO, since they share the chips and the text files are small. There is no format choice in the form.
2. **No train/val split** (spec 069 decision 4). `train` and `val` name the same images.

**Goal:** The folder from spec 069 also trains with Ultralytics YOLO as it is, with no conversion.

## Findings (Ultralytics docs and `ultralytics/data/utils.py` on main, checked 2026-11-12)
- **Label files.** Each image has a `.txt` label file, with one line per object: `class x_center y_center width height`. The coordinates are normalised to 0–1 by the image's width and height, and classes are zero-indexed.
- **Label paths.** A label is found by replacing the last `/images/` in the image's path with `/labels/` (`img2label_paths`). An image with no `.txt` is treated as background.
- **`names`** may be a list or a dict.
- **Root.** `check_det_dataset` takes the dataset root from `path`, else from the yaml file's folder. A relative `path` that doesn't exist resolves under `DATASETS_DIR`, and `path: .` would mean the current directory. So the file leaves `path` out, and `train` and `val` resolve against the yaml's folder.

## Scope
1. **Labels.** For each chip written by spec 069, write `labels/<stem>_<x0>_<y0>.txt` beside `images/` before the next chip is read.
   - One line per kept box, in the plan's order: `<value − 1> <cx> <cy> <w> <h>\n`.
   - `cx = (x0 + x1) / 2 / chipWidth`, and `cy`, `w` and `h` likewise, using the clipped rect in chip pixels.
   - Each number has exactly 6 decimals.
   - Class ids are `value − 1`, so they match the mask values minus one, and stay stable when some classes have no box.
2. **`data.yaml`** is written last, after `annotations.json`:
   ```
   # Written by Geoplatform. train and val are the same images: split them before training.
   train: images
   val: images
   names:
     0: "<name of class 1>"
     1: "<name of class 2>"
   ```
   - There is one `names` entry for every class, ids 0 to the class count − 1.
   - Each name is written with `JSON.stringify`. A JSON string is a valid YAML double-quoted scalar, so names holding `:`, `#` or quotes stay valid.
3. **Cancel and failure** follow spec 069 scope 6. A cancelled run writes no `data.yaml`, so YOLO can't train on an incomplete folder by accident.
4. The finished message is unchanged, and the README names both layouts.

**Out of scope:** a format choice, a train/val split, YOLO segmentation or OBB labels, `test` sets, class subsets.

## Interfaces
- `core/yolo.ts` (pure):
  - `yoloLines(rects: { rect: Rect; value: number }[], chip: { width: number; height: number }): string`;
  - `dataYaml(classes: LabelClass[]): string`.
- `io/dataset.ts` (spec 069) writes `labels/` and `data.yaml`. No other interface changes.

## Acceptance criteria
1. **Unit (yoloLines):** in a 640 × 640 chip, a rect with x0, y0, x1, y1 = 10, 20, 50, 80 and value 3 gives `2 0.046875 0.078125 0.062500 0.093750\n`.
2. **Unit (yoloLines, random rects in chips of 64–2048 px):** every value is within [0, 1], and denormalising gives the rect back to within 0.5 px of the 6-decimal rounding.
3. **Unit (dataYaml):**
   - With classes `Water`, `a: b # c` and `say "hi"`, the `names` lines are `0: "Water"`, `1: "a: b # c"` and `2: "say \"hi\""`.
   - There is no `path` line, and the `train` and `val` lines are `images`.
4. **E2E (spec 069's fake folder, 2 boxes):**
   - Every PNG under `images/` has a `.txt` with the same stem under `labels/`, with one line per kept box of that chip in `annotations.json`.
   - `data.yaml` lists every class.
5. **E2E:** cancelling mid-run leaves no `data.yaml`.
6. **Manual (tester):** from a working directory outside the folder, run `yolo detect train data=<folder>/data.yaml epochs=1 imgsz=640`. It runs one epoch with no label or path warnings. Record the Ultralytics and Python versions.
7. `npm run check` passes.
8. **Docs:** the README names the YOLO files (`labels/`, `data.yaml`) and the unsplit `train`/`val`. The CHANGELOG gets an entry.
