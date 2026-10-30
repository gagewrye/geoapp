# 031: Labels survive a reload

**Status:** Approved by Gage 2026-10-30, with the draft answers to its questions. **ADRs:** 0025. **Amends:**
- Spec 016's "Opacity isn't saved across reloads": a restored session brings its opacity back. Without a restore, a reload still reads 60, so 016's criterion 3 stands.
- README's "labels live in memory until you export them".

**Goal:** A tab that closes, reloads or crashes loses at most the last 2 s of labelling. Reopening the same raster offers the saved labels back.

**Decided by Gage (2026-10-30), as drafted:**
- (a) How many raster sessions to keep. Draft: 8, evicting the least recently saved, and its mask copy with it.
- (b) Prompt or automatic restore. Draft: a `confirm()` prompt.
- (c) Is a full copy of an imported mask acceptable (593 MB for Chunk 11)? The alternative is asking the user to import it again on restore.
- (d) Save undo history? Draft: no.

## Scope
1. **Raster identity.** `rasterKey` is the file's byte size, plus width, height, EPSG and geotransform. A renamed file still matches. Another raster never matches, even one with the same name.
2. **What is saved per key:**
   - the session record: name, `savedAt`, classes, selected class, opacity and Show labels;
   - every stored edit tile;
   - when a mask is loaded, its `lut`, `count`, `windows` and `preview.values`, plus the mask file copied into OPFS. The copy is streamed and runs once per import.
3. **When it saves:**
   - Every changed tile key is marked dirty: applied cells, undo, replace and erase-to-empty. Class and view edits mark the record dirty.
   - A save starts 2 s after the last change, and never during a stroke.
   - A tab going hidden (`visibilitychange`) or closing (`pagehide`) starts a save at once.
   - Each IndexedDB transaction writes or deletes at most 16 tiles (about 1 MiB), then yields.
   - Tiles are copied when saved. The record is written last, with `savedAt`.
   - A replace (an import) clears the key's old tiles first.
   - An import that is cancelled, or a raster closed with no labels, saves nothing new.
4. **Restore.** Once the preview is drawn (spec 019), a matching session prompts `Restore labels saved <local date time> for <name>?`
   - OK reads the tiles in batches of 16, opens the mask copy with `openLabelFile`, and rebuilds the preview corners and buckets from the grid (`previewCells`, `cellBuckets`).
   - It then calls `labels.replace` and restores the selected class and view settings. The message is `Labels restored.`
   - Cancel deletes that session, so new labels start clean.
   - A missing or unreadable mask copy restores the tiles alone. The message then asks the user to import the mask again.
5. **Unsaved guard.** A `beforeunload` listener (`preventDefault` plus `returnValue`, per MDN) is attached only while something is dirty, a save is in flight, or the last save failed.
6. **Save state.** `#save-state` shows `Saved <time>`, `Saving…` or `Not saved: <reason>`.
   - A quota or IndexedDB error keeps the guard on.
   - It never blocks painting.
7. README: labels are kept in this browser until the user cancels a restore or the session is evicted. They still never leave the device.

**Out of scope:** saving undo history, a session manager UI, sync across browsers, saving the raster itself.

## Interfaces
- `core/session.ts`:
  - `rasterKey(size: number, g: Grid): string`
  - `batches(keys: Iterable<string>, n: number): string[][]`
  - `evict(sessions: {key: string; savedAt: number}[], limit: number): string[]`
- `io/session.ts` (the store, a Map-backed fake in tests):
  - `type SessionRecord = { key; name; savedAt; classes: LabelClass[]; selected; opacity; visible; base: { lut: Uint8Array; count: number; windows: string[]; values: Uint8Array } | null }`
  - `interface SessionStore { get(key): Promise<SessionRecord | null>; putRecord(r): Promise<void>; putTiles(key, tiles: [string, ArrayBuffer | null][]): Promise<void>; clearTiles(key): Promise<void>; tiles(key, after: string | null, n: number): Promise<[string, ArrayBuffer][]>; delete(key): Promise<void>; list(): Promise<{key; savedAt}[]>; saveBase(key, file: Blob): Promise<void>; base(key): Promise<Blob | null> }`
- `ui/persist.ts` is the wiring: the dirty set, the debounce, the guard and `#save-state`.

## Acceptance criteria
1. **Unit:** `rasterKey` differs when any of size, width, height, EPSG or a geotransform term differs, and is equal for equal inputs. `batches` and `evict` follow their docstrings.
2. **Unit, fake store and fake timers:**
   - Painting a tile writes it 2 s after the stroke ends, not before, and not during a stroke.
   - Undoing it back to no tile deletes the saved tile.
   - No transaction carries more than 16 tiles.
3. **Unit:** a `visibilitychange` to hidden starts a save without waiting for the debounce.
4. **Unit:** the guard is attached iff (something is dirty, or a save is in flight, or the last save failed). A successful save removes it.
5. **Unit:**
   - A replace clears the old tiles before the new ones are written.
   - Cancelling the restore prompt deletes the session.
   - A ninth session evicts the least recently saved one and its mask copy.
6. **E2E (Chromium):**
   - Open the fixture, paint 2 strokes, rename a class, and set opacity to 30%.
   - Wait for `Saved`, reload, open the same file and accept.
   - The tiles are byte-equal, and the class names, selected class and opacity match.
   - Paint still works.
7. **E2E:** the same flow after importing the fixture mask plus one stroke. After the restore, the mask pixels and the stroke both show, and an Export equals one made before the reload.
8. **E2E:** opening a different fixture after a save shows no prompt, and the first fixture's session still restores afterwards.
9. **E2E:** a reload within 2 s of a stroke raises a `beforeunload` dialog. After `Saved`, a reload raises none.
10. **Perf, Chunk 11:** while saving 256 edited tiles, the longest task is ≤ 50 ms, and the mask copy runs no task over 50 ms. `npm run check` passes.
