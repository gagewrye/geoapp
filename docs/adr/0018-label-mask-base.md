# 0018: An imported label mask is a file-backed base under sparse edit tiles

**Status:** Proposed, with spec 014. Amends ADR 0010 (the store and memory) and ADR 0015 (a null undo entry now means "the mask shows"); ADR 0013's format is unchanged.

**Context:** Gage wants to load a label mask and fine-tune it with the brush. Spec 004 imports into ADR 0010's in-memory store, capped at 256 tiles (16 MiB), so a dense mask larger than about 4096² px fails. Holding it all would break CLAUDE.md's rule against loading full rasters. Checked 2026-10-28:
- geotiff 3.0.5's `fromBlob` reads on demand: `src/source/filereader.js` at tag v3.0.5 reads only `file.slice(offset, offset + length)` for each requested range.
- W3C File API (editor's draft): a `File` read after its file changed fails with `NotReadableError`, and after it was deleted with `NotFoundError`.

The options were:
- (a) Raise the cap: a full raster in memory, and thousands of overlay layers.
- (b) Copy the mask into an OPFS tile store (ADR 0010's option b): the store becomes async, the mask is copied to disk, and display is still unsolved.
- (c) Keep the user's file as a read-only base, resampled per window on demand, with the existing capped tiles as edits that override it whole.

**Decision:** (c). Tiles are copied from the base when the brush first touches them, a null undo entry restores the base, the base is shown as one preview-resolution layer, and export streams the base plus edits.

**Consequences:**
- No dependency. The cap now limits edited tiles, not the mask.
- The base costs about 13 MiB (preview cells 8 MiB, values 1 MiB, canvas 4 MiB), plus up to 264 pending base tiles (16.5 MiB) while strokes wait for reads.
- The mask must stay unchanged on disk for the session.
- Unedited areas show at preview resolution only.
- Export and the first touch of a tile read the file again.
- One base at a time. Train and model seeding would also have to read the base, which spec 013's shelving avoids.
