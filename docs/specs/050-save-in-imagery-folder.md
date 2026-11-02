# 050: Export labels into the imagery's folder

**Status:** Approved (Gage waived review, 2026-11-02, as relayed by the orchestrator), with the recommended answers. **ADRs:** 0034 (Accepted). **Builds on specs 004 and 019, and ADR 0001.** Draft spec 044 calls `openSink` with no folder and is unaffected. A raster opened by draft spec 040 (remote) has no folder.

**Request** (Gage, 2026-11-02): "There is an issue where the web app opens a different folder than the one you pulled the tif from. I might have saved a label_final there on accident." Each chunk has its own folder (`ChunkX_Y.tif`, `labels.tif`, `labels_final.tif`).

## Decided (2026-11-02, recommended options)
1. **Suggested name.** It stays `labels.tif`. The dialog now opens beside the chunk's own `labels.tif`, so Save asks before replacing it, and `labels_final.tif` is typed or clicked as now.
2. **Import labels.** Its chooser also opens in the browser's last-used folder. It is left for a follow-up spec.
3. **Moved imagery.** If the imagery file is moved or deleted after opening, the spec text has the dialog fall back to the last-used folder, but Chrome's behaviour is unverified. Criterion 6 checks it by hand, and the spec returns to the architect only if Chrome throws.

## Why it happens (from the code)
`#open-raster` is an `<input type="file">` (`index.html`, `ui/main.ts`). It gives a `File` with no handle and no path, so the app can't know the folder. Export calls `showSaveFilePicker({ suggestedName: "labels.tif", types })` with no `startIn` or `id` (`io/sink.ts`). Chrome then opens the folder last used by this origin's pickers (WICG File System Access, "determine the directory the picker will start in", step 4). So that is whichever folder the last export went to.

## What the browser allows (ADR 0034)
- `startIn` takes a `FileSystemHandle`, and for a file handle the dialog opens in the file's parent folder. It overrides `id`.
- Only Chromium has `showOpenFilePicker` and `showSaveFilePicker`. Both need a secure context and a user gesture (otherwise `SecurityError`).
- A file chosen with `showOpenFilePicker` comes with a handle. An `<input>` file never does.
- Firefox and Safari have neither picker. The input opens in a folder the browser picks, and the export downloads to the browser's download folder or asks there, per its settings. The app can't change either, so they are unchanged.

## Scope
1. **Open.** Where `showOpenFilePicker` exists, activating `#open-raster` (its label, or a click on the input) prevents the native chooser. It calls `showOpenFilePicker({ types: GeoTIFF .tif/.tiff })` synchronously in the click handler and opens `await handle.getFile()` exactly as a chosen file opens today. Cancelling the picker does nothing and shows no message. Elsewhere, the input works as today.
2. **The folder.** The app keeps the handle of the open raster. It is set when, and only when, a raster replaces `source`. It becomes null when a raster opens through the input (Firefox, Safari, Playwright's `setInputFiles`) or without a file (spec 040). A failed or cancelled open keeps the previous one.
3. **Export.** `openSink("labels.tif", handle)` passes `startIn: handle` when a handle is held, and no `startIn` otherwise. The suggested name is unchanged (Decided 1). No `id` is passed. Everything after the dialog is as today.

**Out of scope:** Import labels and Apply class map (Decided 2); drag and drop; remembering folders across reloads; showing the saved path.

## Interfaces
- `io/filePick.ts`: `canPickFiles(): boolean` and `pickRaster(): Promise<FileSystemFileHandle | null>`. The latter returns null on `AbortError` and rethrows anything else.
- `io/sink.ts`: `openSink(name: string, startIn?: FileSystemHandle): Promise<Sink>`.
- `ui/seeding.ts` `Deps` gains `folder: () => FileSystemHandle | null`.

## Acceptance criteria
1. **Unit (io/sink, fake `showSaveFilePicker`):** `openSink("labels.tif", h)` passes options whose `startIn` is `h`, whose `suggestedName` is `labels.tif`, and with today's `types`. Without `h`, the options have no `startIn` key. Neither has an `id`.
2. **Unit (io/filePick, fake `showOpenFilePicker`):** `pickRaster` returns the first handle. It resolves null when the fake rejects with `AbortError`, and rejects when the fake throws `SecurityError`. `canPickFiles()` is false without `showOpenFilePicker`.
3. **E2E (init script fakes both pickers; the open fake returns handle A for a fixture GeoTIFF and records `navigator.userActivation.isActive`):**
   - A click on Open GeoTIFF opens the raster with no native file chooser (no Playwright `filechooser` event), and the fake saw an active user activation.
   - Export labels then calls the save fake with `startIn` identical to A.
4. **E2E (same fakes):** in each case below, the next export's `startIn` is as stated:
   - after A, opening B through the picker gives B;
   - after A, opening via `setInputFiles` gives no `startIn`;
   - after A, picking B but cancelling spec 031's close question gives A;
   - after A, picking a non-TIFF that fails to open gives A;
   - after A, an open picker that rejects with `AbortError` gives A, with no message.
5. **E2E:** with `showOpenFilePicker` deleted by an init script, clicking Open GeoTIFF fires a `filechooser` event, and the existing open e2e tests pass unchanged.
6. **Manual (tester, Chrome on Gage's machine):** record the Chrome version. Open `Chunk1_1/Chunk1_1.tif`, export into `Chunk2_2/`, then open `Chunk1_1.tif` again and export: the dialog shows `Chunk1_1/` with `labels.tif` suggested. Moving `Chunk1_1.tif` after opening and then exporting gives some dialog and no error (Decided 3).
7. `npm run check` passes. Specs 004, 019 and 031's e2e criteria pass.
8. **Docs:** README's export note says the Save dialog opens in the imagery's folder on Chrome and Edge. ADR 0001's Status names ADR 0034.
