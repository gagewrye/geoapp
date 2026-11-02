import { importEntries, mergeClasses, type ClassEntry } from "../../../src/core/classTable";
import { cellBuckets, fillPreview, PREVIEW_MAX_SIDE, previewCells } from "../../../src/core/maskPreview";
import { markValues, seedLut, seedWindows, sourceCells } from "../../../src/core/seed";
import type { LabelSource } from "../../../src/io/labelFile";
import { gather, gridOf, windowLabels } from "../../../src/io/maskBase";
import type { RasterSource } from "../../../src/io/source";

/** Spec 004's import before spec 024, window by window: classes first (the table, then "Class v" for every other gathered value, spec 047), then the labelling pass. */
export async function twoPassImport(imagery: RasterSource, file: LabelSource, table: ClassEntry[] | null) {
  const dst = gridOf(imagery.meta), src = gridOf(file.meta);
  const windows = seedWindows(dst, src);
  const seen = new Uint8Array(256);
  for (const w of windows) markValues(await gather(file, sourceCells(dst, src, w), w.width * w.height), seen);
  const entries = importEntries(table ?? [], seen, file.meta.nodata);
  const merged = mergeClasses([], entries);
  if (merged === "too many") return merged;
  const lut = seedLut(entries, merged.values);
  const { cells, width, height } = previewCells(dst, PREVIEW_MAX_SIDE);
  const buckets = cellBuckets(cells, dst);
  const values = new Uint8Array(width * height);
  const labelled = new Set<string>(), used = new Set<number>();
  let count = 0;
  for (const w of windows) {
    const { labels } = (await windowLabels(imagery, file, lut, w))!;
    let any = false;
    for (const v of labels) if (v) { any = true; count++; used.add(v); }
    if (any) { labelled.add(`${w.x0},${w.y0}`); fillPreview(values, cells, buckets, w, labels); }
  }
  if (!count) return "empty";
  return { classes: merged.list, lut, count, windows: labelled, preview: values, classCount: used.size };
}
