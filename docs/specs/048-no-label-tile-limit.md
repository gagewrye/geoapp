# 048: No label tile limit

**Status:** Approved by Gage 2026-11-01, with the recommended answers. Criterion 7's e2e removed by spec 060 c14 (2026-11-12): the 324th-tile stroke and smart commit with 323 stored, and the preview render of a stored tile beyond the overlay cap, are no longer tested end to end; unit `core/overlays` keeps the selection and cap. **ADRs:** 0033 (Accepted). **Amends:** spec 003 (Storage's "full" sentence, Display, criteria 4's cap clause and 15's last sentence), spec 004 ("the 256-tile cap stays", Out's "raising `MAX_LABEL_TILES`", criterion 8's cap clause), spec 010 (What an edit is: "at most 256, 16 MiB"; Cap; criterion 6's "`MAX_LABEL_TILES`" becomes "256"), spec 014 (copy-on-touch's cap bullet, Display's hiding rule, criterion 8), spec 018 (criterion 5: "each stored tile with an overlay"), spec 023 (Decided 2, F6's cap bullet, criterion 2's cap clause), spec 032 (error kinds lose `labelLimit` and `editLimit`), spec 037 (scope 4 and criterion 4, per scope 4 below), spec 046 (scope 7's cap bullet, criterion 6's first bullet), README's v1 limits.

**Request** (Gage, 2026-11-01): "remove the 256 tile limit".

**Goal:** Paint and edit labels over a whole raster with no tile limit, while display and undo memory stay bounded.

## Open questions (Gage)
1. **CLAUDE.md conflict.** With no cap, a fully edited raster's labels are all in memory (1 B/px: 41 MiB at 6,571², 115 MiB at 11,000², about 570 MiB for Chunk 11), against "Never load a full raster into memory". *Recommended:* accept it, as ADR 0033 records. The tiles are painted by hand, never read whole from a file, and your 2026-10-30 rule is smoothness over storage. The alternative, spilling saved tiles to IndexedDB (ADR 0033 option b), makes every tile access async and is several times the code.
2. **Overlay budget.** `LABEL_OVERLAYS` = 256 (128 MiB, today's ceiling) or 512 (256 MiB)? Beyond it, tiles show at preview resolution (about 6.4 source px per preview px on a 6,571² chunk). *Recommended:* 256. A view needs more only when zoomed out past 4 source px per CSS px, where the preview is about as sharp as the screen.
3. **Undo.** Keep 32 MiB and 50 steps, with scope 4's exception for one oversized edit, or raise `UNDO_BYTES` to 64 MiB? *Recommended:* keep 32 MiB. Only a stroke over more than 512 stored tiles is affected (the brush is at most 127 px, a smart fill 16 tiles).

## Scope
1. **No cap.** Removed: `MAX_LABEL_TILES`; the `"full"` results of `brush`, `brushSpans` and `putTile`; `PaintQueue`'s `full` event and `PaintOp.done`'s `"full"`; `MESSAGES.labelLimit` and `editLimit`. Copy-on-touch and smart-select commits always apply. Tiles stay in memory, and spec 031 saves and restores them unchanged.
2. **Overlays.** On the settled-view signal spec 027 gives the imagery update, and after each redraw flush, the wanted keys are `overlayKeys(stored keys, viewBox, LABEL_OVERLAYS)`. Wanted keys with no overlay get one, centre first, spread over frames so that no task exceeds 50 ms. Unwanted overlays stay until their room is needed, the least recently wanted going first. The cap counts tiles, not quads (as spec 020 A1). Recolour and Show labels act only on existing overlays. Ids, quads, slot and view properties are unchanged (ADR 0019, spec 016).
3. **Preview.** The `mask` layer (spec 014) shows all labels: the base's values, overwritten in each stored tile's preview pixels by `fillPreview`, and put back by `unfillPreview` when the tile goes. It hides only the pixels of tiles that have an overlay. It is added once the raster has a base or a stored tile. Its cells and buckets are kept for the raster's life, built within spec 030's open targets. The session record's `base.values` stay the base's own values, and a restore refills the preview from the restored tiles.
4. **Undo.** `UNDO_BYTES` and `UNDO_STEPS` are unchanged, and the stroke in progress is never trimmed (as now). `trimHistory` also never drops `keep`, the entry just appended (`settle`) or pushed (undo, redo). Undo copies thus stay within max(`UNDO_BYTES`, one edit's copies).
5. **Docs.** README's limits sentence goes. ADRs 0010, 0015, 0018 and 0019 name ADR 0033 in their status, and each amended spec gets a one-line note.

**Out of scope:** spilling tiles to IndexedDB or OPFS; reduced-resolution overlays; a memory meter; spec 031's save format.

## Interfaces (`core/`)
```ts
export const LABEL_OVERLAYS = 256;   // tiles with full-resolution overlays (ADR 0033)
export function viewBox(full: Grid, bounds: [number, number, number, number]): [number, number, number, number] | null;   // planView's clipped raster-pixel box, x1/y1 exclusive
export function overlayKeys(keys: Iterable<string>, box: [number, number, number, number], max: number): string[];   // keys whose window meets box, nearest tile centre to box centre first, ties row-major, at most max
export function unfillPreview(values: Uint8Array, base: Uint8Array | null, b: CellBuckets, x0: number, y0: number): void;   // window's preview pixels back to base, or 0
brush(...): void; brushSpans(...): void; putTile(...): void;   // signatures otherwise unchanged
trimHistory(history: Edit[], maxBytes: number, maxSteps: number, redo?: Edit[], keep?: Edit): void;
```

## Acceptance criteria
1. **Unit:** on an 8,192 × 8,448 store (1,056 tile windows) with 1,024 tiles, `brush`, `brushSpans` and `putTile` create a 1,025th tile. `src/` contains no `MAX_LABEL_TILES`, `labelLimit` or `editLimit`.
2. **Unit, fake sources:** with a base and 300 stored tiles, a move touching a new base tile copies it, applies, and `done` gets `"ok"`.
3. **Unit:** `overlayKeys` equals a brute-force filter and sort, returns at most `max`, and nothing for a box off the raster. `viewBox` equals the box `planView` uses.
4. **Unit:** `fillPreview` then `unfillPreview` restores the base values, or zeros without a base.
5. **Unit, fake map:** with 400 stored tiles in view, exactly the 256 nearest the centre have overlays. After pans, distinct `label-` tile keys never exceed 256, and the least recently wanted go first. The preview hides exactly the overlaid tiles' pixels and shows the others' tile values.
6. **Unit:** `trimHistory` never drops `keep`. In `UndoHistory`, with ten 1 MiB entries, a stroke over 600 stored tiles (37.5 MiB) drops them all and keeps its own copies. After it ends, it is the only entry. Undo, then redo, leave the 600 tiles byte-equal to before and after it. `bytes()` never exceeds 37.5 MiB. A later one-tile stroke drops it.
7. **E2E, generated 4,608² fixture (324 tiles):** with 323 tiles stored through the hook, a stroke and then a smart-select commit on the last tile each label it, and no error shows. Fitted to the raster, a pixel of an un-overlaid tile renders in its class colour at 0.6 opacity. Zoomed in, it gets a `label-` layer and the same colour.
8. **Unit, fake store:** a restore of a base plus 300 tiles gives the same preview values as before the reload, and the saved `base.values` equal the import's.
9. **Perf, `run.mjs`, typical chunk with every tile stored:** zooming from fit to 1 source px per CSS px, then holding D for 2 s, runs no task over 50 ms, and spec 027 criterion 4's typical target holds. Distinct `label-` tile keys stay ≤ 256.
10. Spec 010 criteria 2 and 6 (as amended), spec 014 criteria 6, 7, 9 and 11, spec 016 criterion 4, spec 031 criteria 6 and 7 and spec 037 criteria 2 to 4 pass. Tests of the cap are deleted or rewritten, each listed in the change. `npm run check` passes.
