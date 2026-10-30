# 0023: Tile quads from a self-checked projected lattice

**Status:** Accepted under Gage's 2026-10-30 perf delegation, with spec 026. Amends ADR 0019 (how its 0.05 px bound is checked).

**Context:** ADR 0019 checks the bilinear error at every pixel corner, which costs about 66,000 proj4 inverses per 256² tile (10–15 ms; perf/baseline.md). Over one tile (25.6 m at 0.1 m pixels) the projection is smooth, so most of that work only confirms what a coarse lattice already shows.

**Decision:** Project a 16 px lattice, interpolate the corners between its nodes, and check each lattice cell's centre exactly. Any miss over 0.005 px halves the lattice for the tile, down to exact. The band search and the 0.05 px bound then run on the interpolated corners.

**Consequences:** No dependency. About 580 projections per tile instead of 66,564. Accuracy is 0.05 px, plus at most 0.005 px between checked points. Unit tests check it exhaustively on representative grids, including EPSG:4326 near the pole.
