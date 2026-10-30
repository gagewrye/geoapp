# 0025: Save label sessions in IndexedDB, with the mask file copied into OPFS

**Status:** Accepted by Gage 2026-10-30, with spec 031.

**Context:** Labels exist only in memory, so a reload loses them. Edit tiles take at most 16 MiB (256 tiles of 64 KiB). The imported mask under them is the user's file, which is read on demand and is 593 MB for Chunk 11. A `File` from `<input>` cannot be read again after a reload. The IndexedDB spec stores a Blob by value, but a large-blob copy in Chrome is not documented ([W3C thread](https://lists.w3.org/Archives/Public/public-webapps/2013AprJun/0902.html), [Mozilla Hacks](https://hacks.mozilla.org/?p=11401)). OPFS `createWritable` streams to a swap file that is swapped in only on `close()`, and is Baseline 2025 (MDN, checked 2026-10-30). `io/sink.ts` already uses it. Both stores share one origin quota: in Chromium that is 60% of the disk, and best-effort data is evicted LRU unless `navigator.storage.persist()` is granted (MDN quotas page, checked 2026-10-30).

**Decision:**
- IndexedDB (database `geoplatform`, version 1, no wrapper library) holds:
  - store `sessions` for metadata, classes, view settings and the base's derived data;
  - store `tiles` for edit tiles as ArrayBuffers, keyed `[rasterKey, tileKey]`.
- An imported mask file is streamed once into OPFS as `bases/<rasterKey hash>.tif`.
- The app calls `persist()` once, when it first saves.

**Consequences:**
- No dependency.
- A session with a base can use about as much disk as its mask file.
- A crash mid-save can leave a mix of old and new tiles. Each tile is whole, so no tile is corrupt.
- Undo history isn't saved.
- Unit tests use a Map-backed fake of `SessionStore`. Real IndexedDB and OPFS are covered only by e2e.
