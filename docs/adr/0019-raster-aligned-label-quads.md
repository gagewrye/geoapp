# 0019: Each label tile is drawn as raster-aligned quads placed by their corners

**Status:** Accepted (Gage, 2026-10-29, with spec 018). Supersedes ADR 0016; amends ADR 0010 (overlay memory). Amended by ADR 0033 (2026-11-01): at most 256 tiles have overlays.

**Context:** ADR 0016 resamples each tile onto a shared Mercator cell grid, each cell showing the pixel holding its centre. So paint lands up to half a cell off the true pixels, in a direction that changes with position. Spec 003's per-tile grid did the same, with coarser cells. Gage saw the paint spill outside the outline. Checked in maplibre-gl 6.16.0 `src/source/image_source.ts`: a canvas source takes four arbitrary corners. `setWarp('flat')` (experimental) pins the image bilinearly on a 16x16 mesh, and corners are rounded to 1/8192 of the covering tile.

**Decision:** Each stored tile is drawn as one canvas per band, with one texel per raster pixel, placed by its pixel-grid corners with the `flat` warp. A band is one of the fewest 2^b row and column bands that keep the bilinear error within 0.05 px. Neighbours share corners.

**Consequences:**
- No dependency. Paint lands on the true pixels, within 0.05 px plus the corner-rounding hairlines ADR 0016 accepted.
- The overlay grid and its sampling when a raster opens go away.
- Memory is 256 KiB of canvas plus 256 KiB of GPU texture per tile, 128 MiB at the cap.
- Most tiles need one source; coarse EPSG:4326 at high latitude needs more, with no fixed bound.
- `setWarp` is experimental, so re-check it on any maplibre-gl upgrade.
