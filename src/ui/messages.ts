/** User-facing strings fixed by specs 001-003, and the ones they don't fix. */
export const MESSAGES = {
  rasterAntimeridian: "Rasters crossing the 180° meridian aren't supported yet.",
  zones: "Areas must lie inside one UTM zone and hemisphere.",
  size: "Area too large (max 20 km per side).",
  rasterIsAef: "This is an AlphaEarth file. Use Open AlphaEarth file.",
  aefIndex: "Couldn't load the AlphaEarth index, so embeddings can't be fetched.",
  // OPFS is shared by the origin's tabs, so one tab at a time holds the AlphaEarth cache (tester F10)
  aefOtherTab: "AlphaEarth embeddings are open in another tab. Close that tab, then fetch again.",
  labelLimit: "Label limit reached (256 tiles of 256 x 256 px). Erase elsewhere first.",
  paintTwo: "Paint at least two classes.",
  noSamples: "No training samples: every painted pixel is nodata.",
  className: "Class names must be unique and not empty.",
  discard: "Discard labels?",
} as const;
