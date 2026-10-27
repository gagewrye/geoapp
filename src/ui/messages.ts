/** User-facing strings fixed by specs 001 and 002, and the ones they don't fix. */
export const MESSAGES = {
  antimeridian: "Polygons can't cross the 180° meridian. Draw one on each side instead.",
  latitude: "Polygons can't extend beyond 85° north or south.",
  rasterAntimeridian: "Rasters crossing the 180° meridian aren't supported yet.",
  zones: "Areas must lie inside one UTM zone and hemisphere.",
  size: "Area too large (max 20 km per side).",
  // not fixed by spec 002: AlphaEarth data is never a labelling surface, so it has its own control
  rasterIsAef: "This is an AlphaEarth file. Open it with \"Open AlphaEarth file\".",
  aefIndex: "Couldn't load the AlphaEarth index, so embeddings can't be fetched.",
  // OPFS is shared by the origin's tabs, so one tab at a time holds the AlphaEarth cache (tester F10)
  aefOtherTab: "AlphaEarth embeddings are open in another tab. Close that tab, then fetch again.",
} as const;
