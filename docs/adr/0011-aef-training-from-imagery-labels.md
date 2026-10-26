# 0011: AlphaEarth training from imagery labels: drawn AOI, supersampled pure-label transfer

**Status:** Proposed

**Context:** AlphaEarth is never hand-labelled (Gage, 2026-10-26). Labels are painted on local imagery on that imagery's own grid, which can be any ADR 0002 CRS at any resolution (spec 003). They can then train a model on the 10 m UTM AlphaEarth grid (spec 004). ADR 0005 requires AlphaEarth requests that don't depend on the labels. There are three AOI options: (a) spec 002's drawn rectangle; (b) the imagery's extent, which sends a private raster's footprint without any user action and fails above 20 km or across zones; (c) the labels' bounding box, which makes the requests depend on the labels. There are three transfer options: (1) the label at each AlphaEarth pixel centre (nearest neighbour), which labels mixed 10 m pixels and misses thin strokes on fine imagery; (2) a majority vote, which keeps mixed pixels; (3) k x k supersampling with a purity rule.

**Decision:** Use (a) and (3). k = clamp(ceil(10 m / source pixel size), 1, 8). An AlphaEarth pixel takes class v when at least half of its sub-points are labelled and all of those are v. At k = 1 this is the same as (1). Transfer is pure math in `core/` and reads only the label store.

**Consequences:** No new dependency. Requests reveal only the drawn area and the year. Labels outside the AOI are ignored. Mixed and thinly labelled pixels drop out, which gives fewer but cleaner samples. Each AlphaEarth pixel near a label costs k² projections, at most 64. On sub-metre imagery, strokes narrower than 1.25 m can be missed.
