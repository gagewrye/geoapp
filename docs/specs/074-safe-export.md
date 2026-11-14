# 074: Export never destroys a file

**Status:** Approved by Gage in advance, 2026-11-14 ("I dont care what it needs. make absolutely sure labels are never lost. approve any adr or spec"), as relayed by the orchestrator. **ADRs:** 0040, 0041. **Amends:** ADR 0001 and spec 050 (the save path), ADR 0018 ("the mask must stay unchanged on disk"), and README step 5. **Sibling:** spec 075 (sessions).

**Request** (Gage, 2026-11-14): "fix this on the geoapp. I lost 2 hours." He exported over the imported `labels_merged.tif` and got a 0-byte file. The same happened to 3 other label files.

## Root cause (from the code)
1. `io/sink.ts:12` calls `showSaveFilePicker`. When the user picks an existing file, the picker empties it before it returns ("Set entry's binary data to an empty byte sequence", WICG File System Access, 10 Oct 2025).
2. Export then reads the imported mask for every unedited window: `seeding.ts:183` → `labelExport.ts:21` → `maskBase.ts:92` → `:73` → `:62` reads `base.file`. That is the user's own `File` (`seeding.ts:91`, ADR 0018).
3. That file is the one the picker just emptied, so the first read fails with `NotReadableError` (`labelFile.ts:86`). `seeding.ts:185` aborts the writable, which discards its swap file. The emptied file stays at 0 bytes, and `seeding.ts:190` says "Import it again", which is now impossible.

## Scope
1. **Mask read from the app's copy.** Once spec 031's OPFS copy of an import is written and its size matches the source, the live base's `file` becomes that copy (ADR 0041). After that the app never reads the user's file again.
   - Export waits while the copy is in progress. It does not wait when the copy has failed (spec 032 `noCopy`).
2. **Folder-based save on Chromium (ADR 0040).** Export labels runs these steps:
   - `showDirectoryPicker({ mode: "readwrite", startIn })`, with spec 050's handle as `startIn`.
   - `prompt("Save labels as", "labels.tif")`. A missing `.tif` is added. A name with a path separator or a character Windows refuses is refused with a message.
   - `getFileHandle(name, { create: true })`, then `createWritable()`. No byte reaches the file until `close()` (WHATWG File System).
   - Picking no folder or cancelling the prompt does nothing and shows no message.
3. **Target checks**, done after the prompt and before the file handle is created. They use `isSameEntry` when the app holds a handle. Without a handle, a file with the same name and size counts as a match.
   - **The open imagery:** refused with `That is the imagery file. Choose another name.`
   - **The imported mask, before the app's copy exists:** refused with `That is the imported mask, and this browser couldn't keep a copy of it. Choose another name.` This includes a restored session whose mask still reads the user's file (spec 075 strays); that name stays refused until the raster is reopened.
   - **Any other existing file, including the imported mask once copied:** `confirm("Replace <name>? It stays as it is until the new file is complete.")`. Cancel writes nothing.
4. **Verify.** After `close()`, the written file's size must equal `tiffLayout().totalBytes`. Then the message is `Labels exported to <name> (<MB> MB).`. A size mismatch shows an error that names the file.
5. **Failure.** Any error before `close()` aborts the writable, and the target keeps its old bytes. The labels, the mask, Undo and the session are unchanged (spec 075 criterion 6). The message is the error, plus `Nothing was overwritten.`
6. **Other browsers** keep ADR 0001's OPFS-then-download path. A download never overwrites a file.
7. **Docs:**
   - README step 5 says export writes into a chosen folder, never overwrites a file until the new file is complete, and refuses the imagery.
   - README line 29 says the app stops reading the imported file once its copy is saved.
   - ADR 0001 and ADR 0018's Status lines name ADRs 0040 and 0041.

**Out of scope:** export cancel button, compression, BigTIFF.

## Interfaces
- `core/exportTarget.ts`:
  - `exportName(input: string): string | null` returns the normalised `.tif` name, or null if the name is refused.
  - `targetAction(t: { exists: boolean; imagery: boolean; mask: boolean; maskCopied: boolean }): "write" | "replace" | "refuse-imagery" | "refuse-mask"`. It returns `write` when `!exists`, and otherwise checks in scope 3's order.
- `io/sink.ts`:
  - `pickFolder(startIn?: FileSystemHandle): Promise<FileSystemDirectoryHandle | null>`, which is null on `AbortError`.
  - `folderSink(dir, name): Promise<Sink & { size(): Promise<number> }>`.
  - `downloadSink(name): Promise<Sink>`.
  - `sameFile(a: FileSystemHandle | null, b: FileSystemHandle): Promise<boolean>`.
- `ui/seeding.ts` keeps the import's handle (spec 053's picker) next to the base. `ui/labels.ts` gains `useCopy(prev: MaskBase, file: LabelSource): boolean`, which swaps the file only while `base === prev`.

## Acceptance criteria
1. **Unit:** `exportName` gives `"a"`→`a.tif`, `"a.TIF"`→`a.TIF`, `" b.tif "`→`b.tif`, and null for `""`, `"x/y"`, `"x\\y"`, `"a:b"`, `"con"`. `targetAction` covers all 16 input combinations as scope 3 says.
2. **Unit (fake handles):** the export path never calls `showSaveFilePicker` when `showDirectoryPicker` exists. On a picker `AbortError` or a null prompt, nothing is written and no message shows.
3. **Unit (fake sink that throws on tile 3):** `abort` is called and `close` is not. The labels store, the base and the undo depth are unchanged. The message ends `Nothing was overwritten.`
4. **Unit:** after the copy is written, `labels.base().file` reads the copy's blob, and a read of the user's file is never made again. A copy whose size differs from the source is not used.
5. **E2E, export over the imported file (Chromium, init script):**
   - The setup:
     - The folder fake returns an OPFS directory that holds the mask fixture as `labels_merged.tif`.
     - The import picker fake returns that file's handle.
     - The save-file fake, if called, empties the chosen file as the WICG spec does.
   - The steps:
     - Import `labels_merged.tif`, paint 2 strokes, and wait for `Saved`.
     - Export with the name `labels_merged.tif` and accept the replace prompt.
   - Expected:
     - The file is `totalBytes` long.
     - Re-importing it gives tiles equal to `labels.tile(key)` for every edited key and for 4 unedited masked keys.
     - A stroke on an unedited masked tile afterwards applies with no error.
6. **E2E:** exporting with the imagery's file name is refused with scope 3's text, and the imagery's bytes are unchanged.
7. **E2E:** with the folder's `getFileHandle` wrapped so the write rejects midway, a pre-existing `labels.tif` keeps its old bytes, and a reload then a restore gives the same tiles.
8. **E2E:** with `noCopy` forced (fake quota), exporting as the imported file's name is refused. Another name succeeds.
9. **Manual (tester, Chrome on Gage's machine; record the version):** repeat criterion 5 on a copy of `Chunk 1 0-2\labels_merged.tif` through the real dialogs.
10. `npm run check` passes. Spec 050's criteria 3 and 4 are re-pointed from the save picker's `startIn` to the folder picker's.
