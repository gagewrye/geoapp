/** User-facing strings fixed by spec 001. */
export const MESSAGES = {
  antimeridian: "Polygons can't cross the 180° meridian. Draw one on each side instead.",
  latitude: "Polygons can't extend beyond 85° north or south.",
  rasterAntimeridian: "Rasters crossing the 180° meridian aren't supported yet.",
} as const;
