# 0039: Detection datasets are written into a chosen folder, as PNG chips

**Status:** Accepted (Gage, 2026-11-12, as relayed by the orchestrator), with specs 069 and 070.

**Context:** COCO and YOLO trainers need image files plus annotations, so one export is hundreds of files. Checked 2026-11-12: `showDirectoryPicker({ mode: "readwrite" })` is in Chrome and Edge 86+ but not in Firefox or Safari (MDN browser-compat-data; experimental, standards track). It needs a secure context and a user gesture, and rejects with `AbortError` on cancel (MDN, page modified 2026-09-11). `OffscreenCanvas.convertToBlob` is Baseline (since March 2023) and must support `image/png` (MDN), and Ultralytics accepts PNG (its detect-dataset docs). The alternative is a ZIP download, through a ZIP library (a dependency) or a hand-written writer. Either needs ZIP64 past 4 GiB or 65,535 files.

**Decision:** The export uses `showDirectoryPicker`. It makes a new subfolder in the chosen folder and writes the chips one at a time. Chips are 8-bit RGB PNG in the displayed colours: the preview's band ranges, as Smart select sees them. In a browser without `showDirectoryPicker`, the dataset export button is disabled, and its title says it needs Chrome or Edge.

**Consequences:** No dependency. Firefox and Safari get only the GeoJSON export; the README already names Chromium. Raw band values and bit depth are not in the chips, so the ranges go into the COCO `info`. A failed export leaves behind the files already written.
