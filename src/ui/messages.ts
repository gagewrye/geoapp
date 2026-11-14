import type { Skip } from "../core/classTable";
import { maskReadFailed } from "../io/labelFile";
import { RasterRefusedError } from "../io/pipeline";
import type { SeedOutcome } from "../io/seeding";

/** Bytes as MiB rounded up: whole numbers from 10 MiB, else two decimals (a test hook lowers the limit). */
const mib = (bytes: number) => { const v = bytes / 2 ** 20; return v >= 10 ? Math.ceil(v) : Math.ceil(v * 100) / 100; };

/** User-facing strings fixed by specs 001-014, and the ones they don't fix. */
export const MESSAGES = {
  rasterAntimeridian: "Rasters crossing the 180° meridian aren't supported yet.",
  className: "Class names must be unique and not empty.",
  discard: "Close these labels? They stay saved in this browser.", // spec 032: they stay in the browser (spec 031)
  labelFile: "Label files must be single-band 8-bit GeoTIFFs.",
  tooMany: "Too many classes (max 255). Nothing was seeded.",
  noSeed: "No labels to seed here.",
  // spec 004, Settled in build
  replace: "Replace labels?",
  // spec 014
  maskGone: "The label mask can't be read any more. Import it again.",
  // spec 021
  importing: "Importing labels…",
  importCancelled: "Import cancelled.",
  // spec 019
  rasterUnreadable: "Couldn't read this file.",
  buildingPreview: "Building preview…",
  drawingPreview: "Drawing preview…",
  // spec 020
  imageryUnreadable: "Couldn't read part of this file, so some detail may be missing.",
  largeBlocks: (bytes: number, limit: number) => `Full resolution isn't available: this file stores pixels in ${mib(bytes)} MiB blocks (limit ${mib(limit)} MiB). Re-save it tiled, e.g. gdal_translate -of COG.`,
  // spec 031
  restore: (savedAt: string, name: string) => `Restore labels saved ${savedAt} for ${name}?`,
  restored: "Labels restored.",
  pendingDiscard: (name: string, reason: string) => `Labels for ${name} couldn't be saved (${reason}). Discard them?`,
  restoredNoMask: "Labels restored without the imported mask, whose saved copy can't be read. Import it again.",
  // spec 056 scope 1: a decline kept nothing apart, so as not to hide R behind a second replaced session
  restoredStray: "Labels restored: they have unsaved changes, and the earlier replaced labels aren't exported.",
  // spec 038
  picked: (name: string) => `Picked ${name}.`,
  noLabel: "No label here.",
  noClass: (v: number) => `No class for value ${v}.`, // spec 039
  // spec 046
  smartUnavailable: "Smart select isn't available on this device.", // spec 055
  smartDownload: "Smart select downloads an 80 MB model from Hugging Face once. Download it?", // spec 055
  // spec 054
  filled: (px: number) => `Filled ${px.toLocaleString("en-US")} px.`,
  fillClipped: (px: number) => `Filled ${px.toLocaleString("en-US")} px, out to one fill's reach (about 1000 px from the click). If part is left, click it to go on.`,
  fillSame: "This area already has the selected class.",
  fillNodata: "There is no imagery to label here.",
  polygonTooLarge: "A polygon can span 2048 px at most. Fill this one first, or zoom in.",
  // spec 055
  saveAs: "Save labels as",
  badName: "That name can't be used. Leave out / \\ : * ? \" < > | and names Windows reserves, such as con.",
  exportImagery: "That is the imagery file. Choose another name.",
  exportMask: "That is the imported mask, and this browser couldn't keep a copy of it. Choose another name.",
  exportReplace: (name: string) => `Replace ${name}? It stays as it is until the new file is complete.`,
  exportedTo: (name: string, bytes: number) => `Labels exported to ${name} (${(bytes / 1e6).toFixed(1)} MB).`,
  exportShort: (name: string, got: number, want: number) => `${name} was written with ${got} bytes, not ${want}. Export it again.`,
  nothingOverwritten: "Nothing was overwritten.",
  // spec 056
  restoreDelete: (savedAt: string, name: string) => `Delete the labels saved ${savedAt} for ${name}? This can't be undone. Cancel restores them.`,
  restoreReplaced: (time: string) => `Restore the labels replaced on ${time} instead? The newer labels are kept.`,
  replacedFirst: "Export or restore the earlier replaced labels first.",
  notSaving: (reason: string) => `Labels aren't being saved (${reason}). Export them to keep a copy.`,
} as const;

/** The first skip, and how many more: "[0].value has no class in these labels (+2 more)." (spec 047). */
const skipText = (s: Skip[]) => `${s[0]!.field} ${s[0]!.why}${s.length > 1 ? ` (+${s.length - 1} more)` : ""}.`;

/** What a seeding run says (spec 004), naming the first part of the file's class table it ignored (spec 047); null for a run dropped because another raster opened. */
export function seedMessage(r: SeedOutcome, skipped: Skip[] = []): string | null {
  if (r === "stale") return null;
  if (r === "too many") return MESSAGES.tooMany;
  if (r === "empty") return MESSAGES.noSeed;
  const ignored = skipped.length ? ` Ignored part of the file's class table: ${skipText(skipped)}` : "";
  return `Seeded ${r.pixels} pixels in ${r.classCount} classes.${ignored}`;
}

/** What Apply class map says (spec 047); an error when it matched no class. */
export function classMapMessage(applied: number, skipped: Skip[]): { text: string; kind: MessageKind } {
  const head = applied ? `Class map applied to ${applied} classes.` : "Class map matched no class.";
  return { text: skipped.length ? `${head} Skipped: ${skipText(skipped)}` : head, kind: applied ? "info" : "error" };
}

// A FileReader failure rejects with a ProgressEvent, which has no message (spec 019)
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : MESSAGES.rasterUnreadable);

/** An action's error as shown to the user. */
export function errorText(e: unknown): string {
  return e instanceof RasterRefusedError && e.reason === "antimeridian" ? MESSAGES.rasterAntimeridian : messageOf(e);
}

/** A paint or export error as shown: a mask file that can't be read any more gets spec 014's message. */
export function readErrorMessage(e: unknown): string {
  return maskReadFailed(e) ? MESSAGES.maskGone : messageOf(e);
}

/** A message's kind (spec 032): only errors show in red. */
export type MessageKind = "info" | "error";

/** say() for #message: sets the text, and class error for errors only. */
export function messageSink(el: { textContent: string | null; classList: { toggle(c: string, on: boolean): unknown } }) {
  return (text: string, kind: MessageKind = "info"): void => {
    el.textContent = text;
    el.classList.toggle("error", kind === "error");
  };
}
