# 0042: One saved session per labelling run, normally two per raster, evicted only once exported

**Status:** Accepted (Gage approved in advance, 2026-11-14, as relayed by the orchestrator), with spec 075. Amends ADR 0025's keys and eviction.

**Context:** ADR 0025 keys a session by rasterKey, so an import clears the previous labels; a single Cancel deletes them, and the ninth raster evicts a session even if it was never exported. Options: (a) copy the old session to a backup key on replace, which rewrites every tile; (b) give each session an `id`, with `raster` and `role` fields, and key tiles and the mask copy by `id`, so a replace only rewrites one record.

**Decision:** (b): one `current` and normally one `replaced` session per raster. Eviction past 8 rasters takes only sessions exported since their last change. Old records are read as `id = raster = key`, with no IndexedDB version bump.

**Consequences:** No dependency. Disk use is normally about twice a raster's mask. Rare failures can leave more `replaced` sessions; the offer reaches each one, and an import is refused while any is unexported. With nothing evictable, the quota is the limit, and spec 075 reports failed saves in `#message`.
