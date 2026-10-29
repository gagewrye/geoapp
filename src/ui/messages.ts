import type { SeedOutcome } from "../io/seeding";

/** User-facing strings fixed by specs 001-004, and the ones they don't fix. */
export const MESSAGES = {
  rasterAntimeridian: "Rasters crossing the 180° meridian aren't supported yet.",
  labelLimit: "Label limit reached (256 tiles of 256 x 256 px). Erase elsewhere first.",
  className: "Class names must be unique and not empty.",
  discard: "Discard labels?",
  labelFile: "Label files must be single-band 8-bit GeoTIFFs.",
  seedFull: "Label limit reached (256 tiles of 256 x 256 px). Nothing was seeded.",
  tooMany: "Too many classes (max 255). Nothing was seeded.",
  noSeed: "No labels to seed here.",
  // spec 004, Settled in build
  replace: "Replace labels?",
  classTable: (field: string) => `The class table is invalid: ${field}.`,
} as const;

/** What a seeding run says (spec 004); null for a run dropped because another raster opened. */
export function seedMessage(r: SeedOutcome): string | null {
  if (r === "stale") return null;
  if (r === "full") return MESSAGES.seedFull;
  if (r === "too many") return MESSAGES.tooMany;
  if (r === "empty") return MESSAGES.noSeed;
  return `Seeded ${r.pixels} pixels in ${r.classCount} classes.`;
}
