# 0024: Read uncompressed TIFF windows ourselves, columns only

**Status:** Accepted under Gage's 2026-10-30 perf delegation, with spec 028.

**Context:** geotiff 3.0.5 decodes every block a window touches, then copies samples one by one in a loop that doesn't yield (`geotiffimage.js:459-530`). On Gage's uncompressed 1-row strips, a 256-px-wide window reads and copies whole 147 KB rows: 60–80 ms tasks and about 20x over-reads (perf/baseline.md). An uncompressed chunky row's bytes for a column range are contiguous, at offsets the file already lists.

**Decision:** For Compression 1, chunky, no Predictor, whole-byte samples, little-endian or 8-bit, `io/rawReader.ts` fetches only each row's needed byte range through spec 025's `blobSource`, and copies the requested samples directly. Every other layout uses geotiff.

**Consequences:** No dependency. A second read path for one layout, kept byte-equal to geotiff by tests. Re-check it if geotiff's sample handling changes.
