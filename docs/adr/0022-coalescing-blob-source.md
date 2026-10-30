# 0022: Our own coalescing Blob source for geotiff.js

**Status:** Accepted under Gage's 2026-10-30 perf delegation, with spec 025.

**Context:** geotiff 3.0.5's `fromBlob` uses `FileReaderSource`: one `Blob.slice` plus FileReader per strip or tile (`source/filereader.js:17-26`), about 100 µs each. That cost dominates reads of 1-row strips. Its `BlockedSource` coalesces ranges, but it isn't exported from the package entry (`geotiff.js:19-25,575-738` export no sources). It also caches fixed 64 KiB blocks, which would re-slice 147 KB strips and need its own cache bound. `GeoTIFF.fromSource` (`geotiff.js:529`) is exported and accepts any object with `fetch(slices, signal)`.

**Decision:** `io/blobSource.ts` implements that contract. It merges the `fetch` calls of one task into runs (gap ≤ 64 KiB, run ≤ 16 MiB) and reads each run with one `slice().arrayBuffer()`, with no cache. Block offsets are loaded eagerly at open.

**Consequences:** No dependency. It depends on geotiff's source contract (`fetch`, `fileSize`), so re-check it on geotiff upgrades. A gap of up to 64 KiB may be read and discarded. A run holds at most 16 MiB, on top of spec 020's read peak.
