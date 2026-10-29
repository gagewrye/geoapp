# 0015: Undo by per-stroke copies of label tiles, capped at 32 MiB

**Status:** Accepted (Gage, 2026-10-27; cap raised from the proposed 16 MiB to 32 MiB), with spec 010. Amends ADR 0010's memory budget. Partly shelved by spec 013 (2026-10-28), lapsed: Train's 16 MiB.

**Context:** Gage wants paint undo, which spec 003 left out. Labels are sparse 256x256 Uint8 tiles (ADR 0010, at most 256 = 16 MiB; about 146 MiB at the cap, 162 MiB during a Train). Options: (a) before a stroke first touches a tile, copy it (64 KiB) or note it absent; undo puts the copies back. (b) Log changed pixels (index, old value): smaller for thin strokes, but a large brush over a full tile costs more than the tile, and needs new code on `brush`'s hot path. (c) Replay strokes from a base state: needs stored strokes and mask reads again.

**Decision:** (a), in `core/` (`recordTiles`, `finishEdit`, `undoEdit`, `trimHistory`). History plus the stroke in progress is capped at `UNDO_BYTES` = 32 MiB and 50 strokes; oldest entries go first, the current stroke (at most 16 MiB) never. Unchanged tiles are dropped when a stroke ends. Opening a raster clears it, as does a successful spec 004 import or seed (`replace()`). Undo is off while spec 004 locks the labels.

**Consequences:** No dependency. Undo adds up to 32 MiB to ADR 0010's worst case (overlays as amended by ADR 0016; under ADR 0019 they total 128 MiB at the cap). At the tile cap that is about 151-185 MiB for typical rasters, or about 295 MiB for high-latitude EPSG:4326; a Train adds 16 MiB. Even a stroke over all 256 stored tiles leaves 16 MiB for earlier steps. `brush` is unchanged. Redo would be a second list of the same entries.
