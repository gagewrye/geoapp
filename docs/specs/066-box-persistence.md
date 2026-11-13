# 066: Boxes survive a reload

**Status:** Accepted (2026-11-12), with the recommended answers, as relayed by the orchestrator. **ADRs:** none. ADR 0025's database (`geoplatform`, version 1) and its stores are unchanged, since the boxes go into the existing session record. **Builds on specs 031, 032, 063 and 064.** It is part of the series in spec 062.

**Release coupling with spec 064.** Build this spec straight after 064 (spec 064 decision 5).
- The repo has no deploy pipeline, so a merge deploys nothing, and 064 and 066 may merge separately.
- Users run the app from a clone of main. Between the two merges, 064's README note says boxes aren't kept across a reload, and this spec removes that note.

**Goal:** Boxes are saved and restored with their raster's session, as mask tiles are (spec 031), and they never leave the device.

## Scope
1. **Record.** `SessionRecord` gains two optional fields:
   - `boxes?: Int32Array`, six values per box in id order: id, value, x0, y0, x1, y1;
   - `nextBox?: number`, the store's `next`.

   A packed array clones fast and takes about 24 B per box. A record from before this spec has neither field, and it restores with no boxes.
2. **Saving.**
   - Every box change marks the record dirty through `edits.record()`, so it saves `SAVE_DELAY_MS` after the last change, or at once when the tab is hidden or closed (spec 031 scope 3). A box change is an add, edit, delete or class change, and an undo or redo whose result names boxes.
   - A save that starts during a box drag waits, as it does for a stroke: `PersistLabels.stroking()` is also true during a box drag.
   - `take()` copies `packBoxes` into the snapshot, so later edits don't change it. A pending snapshot (spec 031 scope 8) keeps its copy.
3. **Guard and close.** `hasLabels()` counts boxes (spec 064). So a session with only boxes saves, holds spec 031's `beforeunload` guard while unsaved, and triggers spec 032's close question.
4. **Restore.** On OK, `restoreSession` also receives the boxes.
   - It sets the `BoxStore` from `unpackBoxes`, after `replace()`, which keeps boxes (spec 063 scope 6).
   - It extends the class list with `Class v` for any box value beyond it, as an import does (spec 064 decision 3).
   - The selection and the undo history are empty (spec 031 decision d).
   - Cancel deletes the session, boxes included, as now.
5. **Validation.** `unpackBoxes` drops any box that is empty, lies outside the raster, or has a value outside 1..255. It sets `next` to the larger of `nextBox` and the largest id + 1.

**Out of scope:** saving the selection or undo history, box export from a saved session without opening it, a session manager.

## Interfaces
- `core/boxes.ts`:
  - `packBoxes(s: BoxStore): Int32Array`;
  - `unpackBoxes(a: Int32Array, next: number, dims: { width: number; height: number }): BoxStore`.
- `io/session.ts`: `SessionRecord` as in scope 1.
- `ui/persist.ts`: `PersistLabels` gains `boxes(): BoxStore`, and `restoreSession` gains a final `boxes: BoxStore` parameter.
- `ui/snapshot.ts`: `Snapshot.record` carries the packed boxes. No store method changes.

## Acceptance criteria
1. **Unit (core):**
   - `unpackBoxes(packBoxes(s), s.next, dims)` deep-equals `s`.
   - Each of an empty box, an out-of-raster box, value 0 and value 256 is dropped.
   - `next` is at least the largest id + 1.
2. **Unit (persist, fake store and timers):**
   - Adding a box writes a record holding it 2 s later, and not during a box drag.
   - Undoing the only box writes a record whose `boxes` is empty.
3. **Unit:** a box added after `take()` is not in that snapshot. With writes failing, opening another raster keeps the first raster's boxes in the pending snapshot, and they are written once writes succeed (spec 031 criterion 12, with boxes).
4. **Unit:**
   - A stored record without `boxes` restores an empty `BoxStore`.
   - A record whose box value is beyond its class list restores with the list extended.
5. **Unit:** spec 031 criteria 2–5 and 11–13 pass unchanged.
6. **E2E (Chromium):**
   - Draw 3 boxes, paint 1 stroke and wait for `Saved`. Reload, open the same file and accept.
   - `__geoapp.boxes()` deep-equals the boxes before the reload, and the tiles are byte-equal.
   - A new box gets an id above all of them.
7. **E2E:**
   - A session with only boxes is offered back after a reload.
   - A reload within 2 s of a box edit raises `beforeunload`.
8. **Perf:** with 20,000 boxes seeded, a save runs no task over 50 ms.
9. `npm run check` passes.
10. **Docs:**
    - The README drops 064's "not kept across a reload" note, and its sentence on browser-kept labels covers boxes.
    - ADR 0025's Status names this spec.
    - The CHANGELOG gets an entry.
