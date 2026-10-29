import { maskReadFailed } from "../io/labelFile";
import type { SeedOutcome } from "../io/seeding";

/** User-facing strings fixed by specs 001-014, and the ones they don't fix. */
export const MESSAGES = {
  rasterAntimeridian: "Rasters crossing the 180° meridian aren't supported yet.",
  labelLimit: "Label limit reached (256 tiles of 256 x 256 px). Erase elsewhere first.",
  className: "Class names must be unique and not empty.",
  discard: "Discard labels?",
  labelFile: "Label files must be single-band 8-bit GeoTIFFs.",
  tooMany: "Too many classes (max 255). Nothing was seeded.",
  noSeed: "No labels to seed here.",
  // spec 004, Settled in build
  replace: "Replace labels?",
  classTable: (field: string) => `The class table is invalid: ${field}.`,
  // spec 014
  mergeMask: "Merge works only while no mask is loaded. Use Replace.",
  editLimit: "Label limit reached (256 edited tiles of 256 x 256 px). Undo strokes, or export the labels and import the export with Replace.",
  maskGone: "The label mask can't be read any more. Import it again.",
} as const;

/** What a seeding run says (spec 004); null for a run dropped because another raster opened. */
export function seedMessage(r: SeedOutcome): string | null {
  if (r === "stale") return null;
  if (r === "mask loaded") return MESSAGES.mergeMask;
  if (r === "too many") return MESSAGES.tooMany;
  if (r === "empty") return MESSAGES.noSeed;
  return `Seeded ${r.pixels} pixels in ${r.classCount} classes.`;
}

/** A paint or export error as shown: a mask file that can't be read any more gets spec 014's message. */
export function readErrorMessage(e: unknown): string {
  return maskReadFailed(e) ? MESSAGES.maskGone : (e as Error).message;
}
