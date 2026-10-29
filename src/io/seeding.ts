import type { LabelClass } from "../core/classes";
import { classesFromValues, ClassTableError, decodeClasses, mergeClasses, parseClasses, type ClassEntry } from "../core/classTable";
import type { LabelStore } from "../core/labelStore";
import { cellBuckets, fillPreview, PREVIEW_MAX_SIDE, previewCells } from "../core/maskPreview";
import { markValues, seedLut, seedWindows, sourceCells } from "../core/seed";
import type { LabelSource } from "./labelFile";
import { gather, gridOf, windowLabels, type MaskBase } from "./maskBase";
import type { RasterSource } from "./source";

/** A label store and its class list (label value = index + 1). */
export type Labels = { store: LabelStore; classes: LabelClass[] };
/** The new labels and mask base, the pixels the import labelled and their class count; or why nothing changed. */
export type SeedOutcome = (Labels & { base: MaskBase; pixels: number; classCount: number }) | "too many" | "empty" | "stale";

/** The import's class table: the class map's, else the file's CLASS_ITEM, else null (classes from values). */
// Throws ClassTableError; text that isn't JSON is reported as field "JSON".
export function importTable(file: LabelSource, classMap?: string): ClassEntry[] | null {
  const text = classMap ?? file.classItem;
  if (text === null) return null;
  let json: unknown;
  try {
    json = classMap !== undefined ? JSON.parse(classMap) : decodeClasses(text);
  } catch {
    throw new ClassTableError("JSON", "is not valid JSON");
  }
  return parseClasses(json, file.meta.nodata);
}

/** Imports a class raster as the mask base, by nearest pixel centre, masked by imagery nodata (specs 004, 014). */
// A null table takes classes from the values first, in a pass that reads no imagery, so the list is
// known before any value is mapped. The labelling pass visits every seedWindows window once, reading
// imagery only where a label would land, and keeps only counts and preview values: the file stays the
// base, read again on demand (ADR 0018). Every import replaces (spec 017): no stored tile, new classes.
// `stale` turns true when another raster opened: the run stops and nothing changes.
export async function importLabels(imagery: RasterSource, file: LabelSource, table: ClassEntry[] | null,
  stale: () => boolean = () => false): Promise<SeedOutcome> {
  const dst = gridOf(imagery.meta), src = gridOf(file.meta);
  const windows = seedWindows(dst, src);
  let entries = table;
  if (!entries) {
    const seen = new Uint8Array(256);
    for (const w of windows) {
      markValues(await gather(file, sourceCells(dst, src, w), w.width * w.height), seen);
      if (stale()) return "stale";
    }
    entries = classesFromValues(seen, file.meta.nodata);
  }
  const merged = mergeClasses([], entries);
  if (merged === "too many") return merged;
  const lut = seedLut(entries, merged.values);
  const { cells, width, height, corners } = previewCells(dst, PREVIEW_MAX_SIDE);
  const buckets = cellBuckets(cells, dst);
  const values = new Uint8Array(width * height);
  const labelled = new Set<string>(), seen = new Set<number>();
  let count = 0;
  for (const w of windows) {
    const r = await windowLabels(imagery, file, lut, w, stale);
    if (!r || stale()) return "stale";
    const { labels } = r;
    let any = false;
    for (const v of labels) if (v) { any = true; count++; seen.add(v); }
    if (!any) continue;
    labelled.add(`${w.x0},${w.y0}`);
    fillPreview(values, cells, buckets, w, labels);
  }
  if (!count) return "empty";
  const base: MaskBase = { file, lut, count, windows: labelled, preview: { values, width, height, corners, buckets } };
  return { store: { width: dst.width, height: dst.height, tiles: new Map(), base: true }, classes: merged.list, base, pixels: count, classCount: seen.size };
}
