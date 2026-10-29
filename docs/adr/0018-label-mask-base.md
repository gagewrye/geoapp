# 0018: An imported label mask is a file-backed base under sparse edit tiles

**Status:** Accepted (Gage, 2026-10-28), with spec 014. Amends ADR 0010 (the store and memory) and ADR 0015 (a null undo entry now means "the mask shows"); ADR 0013's format is unchanged.

**Context:** Gage wants to load a label mask, larger than 4096 px, and fine-tune it with the brush. Spec 004 imports into ADR 0010's in-memory store, capped at 256 tiles (16 MiB), so a dense mask larger than about 4096² px fails, and holding it all would break CLAUDE.md's rule against loading full rasters. Checked 2026-10-28: geotiff 3.0.5's `fromBlob` reads on demand (`src/source/filereader.js` at v3.0.5 reads only `file.slice(offset, offset + length)` per range). The W3C File API (editor's draft) fails a read of a changed `File` with `NotReadableError`, and of a deleted one with `NotFoundError`.

**Options:** (a) raise the cap: a full raster in memory and thousands of overlay layers; (b) copy the mask into an OPFS tile store (ADR 0010's option b): an async store, a disk copy, and display still unsolved; (c) keep the user's file as a read-only base, resampled per window on demand, with the capped tiles as edits that override it whole.

**Decision:** (c). Tiles are copied from the base when the brush first touches them, a null undo entry restores the base, the base shows as one preview-resolution layer, and export streams the base plus edits.

**Consequences:** No dependency. The cap now limits edited tiles, not the mask. The base keeps about 10 MiB (preview values 1 MiB, bucket index up to 4 MiB, canvas 4 MiB, hidden flags 1 MiB, plus a small start array, the LUT and the window keys). An 8 MiB preview-cells array exists only during an import. At most 4 base tiles (256 KiB), those of the cell being applied, are held while it waits for reads. The mask must stay unchanged on disk for the session. Unedited areas show at preview resolution only. Export and the first touch of a tile read the file again. One base at a time; Train and model seeding would also have to read it, which spec 013's shelving avoids.
