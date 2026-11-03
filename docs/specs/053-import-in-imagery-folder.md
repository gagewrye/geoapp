# 053: Import labels opens in the imagery's folder

**Status:** Approved as a minor fix (Gage, 2026-11-02: small fixes go architect to implementer without sign-off). **ADRs:** 0034 (Accepted, unchanged: same picker, same `startIn` rule). **Builds on specs 004 and 050.** Spec 050 Decided 2 left this for a follow-up; this is it.

**Request** (Gage, 2026-11-03): "import labels should bring up the folder that the tif was selected from. It brought up another folder"

**Goal:** on Chrome and Edge, Import labels' chooser opens in the open imagery's folder; other browsers are unchanged.

## Why it happens (from the code)
`#import-labels` is an `<input type="file">` (`index.html`). Its chooser opens wherever Chrome likes, since no input can be given a folder. Spec 050 already holds the imagery's handle (`folder` in `ui/main.ts`, passed to `ui/seeding.ts` as `Deps.folder`), but only Export uses it.

## Scope
1. **Import labels.** If `canPickFiles()` is true and `folder()` is non-null, a click on `#import-labels` (from its label or the input) prevents the native chooser. It calls `pickRaster(folder())` synchronously in the click handler, so nothing is awaited first. A returned handle's `await handle.getFile()` then goes through exactly today's `change` path: the disabled and imagery checks, spec 017's replace confirm, then `runImport`. Cancelling the picker (null) does nothing and shows no message. Any other rejection, or a `getFile` failure, is said as an error the way a failed import read is.
2. **Otherwise unchanged.** With no picker (Firefox, Safari), or no held handle (imagery opened through the input, by `setInputFiles`, or spec 040's remote open), the input's native chooser works as today.
3. **The folder stays the imagery's.** Importing never changes `folder`, so Export still starts beside the imagery.

**Out of scope:** Apply class map. Its JSON (for example `classes.json`, spec 047 Decided 3) belongs to a set of pseudo-label rasters, not to one chunk, so the chunk's folder is not clearly better than Chrome's last-used folder. Also out: drag and drop, remembering folders across reloads, and an `id`.

## Interfaces
- `io/filePick.ts`: `pickRaster(startIn?: FileSystemHandle): Promise<FileSystemFileHandle | null>`. The options get `startIn` only when it is given; with no argument they are byte-for-byte today's. The return value and error handling are unchanged.
- `ui/seeding.ts`: no new `Deps`. It uses `folder` and imports `canPickFiles` and `pickRaster`.

## Acceptance criteria
1. **Unit (io/filePick, fake `showOpenFilePicker`):** `pickRaster(h)` passes `{ types: [GeoTIFF .tif/.tiff], startIn: h }`. `pickRaster()` passes options with no `startIn` key (spec 050 criterion 2 still passes). Neither passes an `id`.
2. **E2E (spec 050's picker fakes, with the open fake also recording each call's `startIn` by identity and handing out a label-file handle L):** open imagery A through the picker, then click Import labels. No Playwright `filechooser` event fires. The open fake's second call has `startIn` identical to A and saw an active user activation. The import of L then ends with the same labels and message as spec 004's `setInputFiles` import of the same file.
3. **E2E (same fakes):** after A, an Import labels picker that rejects with `AbortError` imports nothing, shows no message and leaves the labels and Undo unchanged. With labels painted, picking L and dismissing the replace confirm imports nothing.
4. **E2E (same fakes):** after A and an import through the picker, Export labels' save fake gets `startIn` A.
5. **E2E (same fakes):** with the imagery opened by `setInputFiles` (no handle), clicking Import labels fires a `filechooser` event and the open fake is not called. With `showOpenFilePicker` deleted by an init script, the same holds after any open.
6. **E2E (same fakes, A held):** clicking Apply class map fires a `filechooser` event and the open fake is not called.
7. **Manual (tester, Chrome on Gage's machine):** record the Chrome version. Open `Chunk1_1/Chunk1_1.tif`, export into `Chunk2_2/`, then click Import labels: the dialog shows `Chunk1_1/`.
8. `npm run check` passes. The e2e criteria of specs 004, 017, 021, 047 and 050 pass unchanged (they import with `setInputFiles`, which bypasses the click).
9. **Docs:** README item 4 says that on Chrome and Edge Import labels' chooser opens in the imagery's folder.
