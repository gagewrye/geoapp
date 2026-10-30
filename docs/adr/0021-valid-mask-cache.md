# 0021: Per-raster valid-mask cache, filled in the background by row reads

**Status:** Accepted (Gage, 2026-10-30: "optimize for smoothness over storage"), with spec 023. Amends ADR 0015 (memory) and spec 003 (masks were dropped after each cell).

**Context:** Paint reads a 256² imagery window for each new key, and drops the mask once the key is left unstored. On 1-row strips each read decodes 256 full-width strips (6.7–11 MB) and keeps 3% of them. This is the main paint lag on Gage's chunks. geotiff 3.0.5 decodes whole strips (`geotiffimage.js:252`) and has no bounded cache (`geotiffimage.js:202`).

**Decision:** Keep each window's valid mask for the raster's life: `"all"` or `"none"` when uniform, else 8 KiB of bits. Least recently used arrays are dropped only past 256 MiB. Masks are read by 256-row bands through spec 020's `rowReads`, at most 16 MiB decoded per read, one read at a time. Order: stroke, then hover, then background from the view's centre, the background only while the imagery loader is idle.

**Consequences:** No dependency. A whole raster is read once after open. Memory adds masks (15 MiB for an 11,000² chunk, 256 MiB at most), one read (about 48 MiB) and 4 label-file row bands (64 MiB): about 900 MiB at worst. A changed imagery file isn't re-read until it is opened again.
