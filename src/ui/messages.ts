import type { SeedOutcome } from "../io/seeding";

/** User-facing strings fixed by specs 001-004, and the ones they don't fix. */
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
  labelFile: "Label files must be single-band 8-bit GeoTIFFs.",
  seedFull: "Label limit reached (256 tiles of 256 x 256 px). Nothing was seeded.",
  tooMany: "Too many classes (max 255). Nothing was seeded.",
  noSeed: "No labels to seed here.",
  // spec 004, Settled in build
  modelNames: "The model's class names must be unique and not empty, with no spaces around them. Nothing was seeded.",
  minConfidence: "Min. confidence must be between 0 and 1.",
  replace: "Replace labels?",
  classTable: (field: string) => `The class table is invalid: ${field}.`,
} as const;

/** What a seeding run says (spec 004); null for a run dropped because another raster opened. */
export function seedMessage(r: SeedOutcome): string | null {
  if (r === "stale") return null;
  if (r === "full") return MESSAGES.seedFull;
  if (r === "too many") return MESSAGES.tooMany;
  if (r === "empty") return MESSAGES.noSeed;
  if (r === "bad names") return MESSAGES.modelNames;
  return `Seeded ${r.pixels} pixels in ${r.classCount} classes.`;
}
