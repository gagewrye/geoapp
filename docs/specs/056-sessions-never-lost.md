# 056: Saved labels are never silently lost

**Status:** Approved by Gage in advance, 2026-11-14 ("approve any adr or spec"), as relayed by the orchestrator. **ADRs:** 0037. **Amends:** spec 031 scopes 3 and 4 and criterion 5, spec 032 scope 5, and ADR 0025. **Sibling:** spec 055.

## Open question (fact-finding; it does not block this spec)
What did the restore show on 2026-11-14: `Labels restored.` but without the 2 hours of edits, `…without the imported mask…`, or no prompt at all? The code has no path from a failed export to the session (`seeding.ts:167-196` never calls persist), and a restore reads only IndexedDB and the OPFS copy, never the user's file (`snapshot.ts:56-73`). So the loss came through one of the paths below. This spec closes all of them.

## Silent loss paths found (from the code)
- **A. One Cancel deletes the session.** Cancel on the restore prompt deletes it at once (`persist.ts:228`).
- **B. An import erases the old session.** It marks `clear` (`persist.ts:267`), and the next save deletes every old tile (`snapshot.ts:41`) after a single `Replace labels?`.
- **C. A failed copy blocks all saving.** The mask copy is written before any tile (`snapshot.ts:42`). Any copy error that isn't a quota error, such as `NotReadableError` from a changed file, then blocks every tile and record write. The retries never end (`persist.ts:149`), and the only sign is the status bar.
- **D. Eviction ignores exports.** The ninth raster evicts the least recently saved session, whether or not it was ever exported (`snapshot.ts:51`, `core/session.ts:25`).
- **E. Failed saves are easy to miss.** A save that keeps failing shows only in `#save-state`.

## Scope
1. **Restore decline (A).** A Cancel on the restore prompt asks `Delete the labels saved <time> for <name>? This can't be undone. Cancel restores them.` OK deletes the session, except with a stray (below); Cancel restores it. If the mask copy can no longer be read, the labels are restored without it (`Labels restored without the imported mask…`) and the tiles are kept.
   - **Strays.** A **stray** is a pending (failed, still-queued) snapshot of this raster from an earlier open, e.g. its save failed after the raster was reopened. The offer waits for in-flight saves before it looks up sessions. On restore, the stray's newer labels are laid over the restored ones and saved. On decline with a stray, the session is not deleted but kept as the raster's `replaced` one, because the delete question showed only the stored labels, not the stray's newer ones. Except: if the raster already has an unexported `replaced` session, a decline with a stray neither deletes nor demotes; the session is restored with the stray laid over, and `#message` shows `Labels restored: they have unsaved changes, and the earlier replaced labels aren't exported.` These two cases are the only exceptions to "OK deletes".
2. **Replaced labels are kept (B, ADR 0037).** A session gets its own `id`. Records gain `raster` (the rasterKey), `role` (`"current"` or `"replaced"`) and `exportedAt: number | null`. Tiles are keyed `[id, tile]`; the mask copy is `bases/<keyHash(id)>.tif`. An import that replaces saved labels turns the current session into the raster's `replaced` one. While any `replaced` session of the raster is unexported (not exported after its last change), the import is refused with `Export or restore the earlier replaced labels first.` Otherwise the earlier `replaced` sessions are deleted. The new labels start a new `current` session; nothing is cleared. One `replaced` session per raster is the normal case, not an invariant: rare failures (scope 1's strays) can leave more, and every one stays reachable. Existing records are read as `id = raster = key`, `role = "current"` and `exportedAt = null`; no IndexedDB version bump is needed.
   - **With `replaced` sessions,** Cancel on the current session's prompt asks `Restore the labels replaced on <time> instead? The newer labels are kept.` for each in turn, newest first. OK restores that session, and it swaps roles with the current one. Cancel on the last one goes on to scope 1's delete question.
   - **With no `current` session,** the newest `replaced` one gets the normal prompt, and the others follow as above.
3. **Copy never blocks tiles (C).** The save order becomes: tiles; the record, with `copyMissing: true` until the copy succeeds; the copy; the record again, without the flag. A copy error that isn't a quota error is retried at most 3 times. After that it is handled like a quota error: no copy until the next import.
4. **Eviction (D).** With more than 8 rasters, only sessions with `exportedAt ≥ savedAt` are evicted, oldest first. An unexported session is never evicted. When nothing can be evicted, everything is kept.
5. **Loud failure (E).** When a save first fails, and again on each failure after a successful save, `#message` shows the error `Labels aren't being saved (<reason>). Export them to keep a copy.` The guard stays on as now.
6. **Export marks the session.** A verified export (spec 055 scope 4) sets `exportedAt` and saves the record. A failed export changes nothing in the session. Only a folder export marks it; a download doesn't, since it may be cancelled. Any later label, class or view change makes the session unexported again. So on Firefox and Safari (download only) no session is ever evictable, and the quota is the limit (ADR 0037).

**Out of scope:** A session manager UI. `navigator.storage.persist()` being denied: the browser decides it, and export is the remedy. Two tabs on one raster. A stray whose writes keep failing lives only in the page; it can't be restored before it is written and blocks imports for that page session (safe: nothing is lost).

## Interfaces
- `core/session.ts`: `evict(s: { id: string; savedAt: number; exportedAt: number | null }[], limit: number): string[]`; `offers(records: { role: string; savedAt: number }[]): number[]` gives the record indexes in offer order: current first, then replaced, each newest first.
- `io/session.ts`: `SessionStore.get(key)` becomes `forRaster(raster): Promise<SessionRecord[]>`; `SessionRecord` gains `id`, `raster`, `role` and `exportedAt`.
- `ui/persist.ts` gains `exported(at: number): void`.

## Acceptance criteria
1. **Unit:** `evict` never returns an id whose `exportedAt` is null or less than `savedAt`. With 10 rasters all unexported it returns `[]`. With 10 rasters of which 3 are exported it returns the 2 oldest exported ones. `offers` follows its docstring.
2. **Unit, fake store (no stray):** Cancel, then Cancel restores the session. Cancel, then OK deletes it. Neither path deletes on a single Cancel.
3. **Unit:** import mask A, paint, save, import mask B, and save; A's tiles, record and copy are still stored as `replaced`, and B's are `current`. A third import, with A not exported, is refused with scope 2's message and changes no labels.
4. **Unit, fake store whose `saveBase` rejects with `NotReadableError`:** painted tiles and the record (`copyMissing: true`) are written on the first save; `saveBase` is called at most 4 times in 10 minutes; scope 5's message shows once.
5. **Unit:** a store holding a spec 031 record keyed by rasterKey restores byte-equal tiles and its copy.
6. **E2E:** import the fixture mask, paint, and wait for `Saved`. Run a failing export (spec 055 criterion 7), reload, and accept the restore: the tiles equal those before the export. Repeat with a successful export: the record's `exportedAt ≥ savedAt`.
7. **E2E:** import mask A, paint, import mask B, paint, reload, and open. Cancel the prompt, then OK `…instead?`: A's labels show. Reload, open and accept: A's labels again, with B's still stored as `replaced`.
8. `npm run check` passes. Spec 031's criteria 6–8 pass with the new prompts.
9. **Unit, strays (scope 1):** raster A imports a mask and paints `256,0` = 1. B opens while A's copy is held. A reopens, then the copy fails with `NotReadableError`.
   - Restore, paint `256,0` = 2, rename the class, run 10 minutes of flushes: the stored tile is 2, the classes and `savedAt` are the new session's, and there is one `current` record.
   - Cancel, then OK to delete: the old session is kept as `replaced` with tile 1, and a new `current` session with another id has tile 2. An import is refused. A new open offers the kept labels through `…instead?` and restores them without the mask.
   - With an unexported `replaced` session R stored first, Cancel, Cancel, OK: the session is restored with the stray laid over and scope 1's message shows. R is still the only `replaced` session and is still offered through `…instead?`. No stored or stray tile is lost.
10. **Unit, fake store with a current session and two unexported `replaced` sessions, R1 older than R2:**
    - Cancel, Cancel on R2's `…instead?`, OK on R1's: R1's labels are restored and R1 becomes `current`. R2 and the old current session are stored as `replaced`.
    - In a separate run, an import is refused with scope 2's message while R1 is unexported, even after R2 is exported.
