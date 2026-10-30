import type { LabelClass } from "../core/classes";
import { classesFromValues, ClassTableError, decodeClasses, mergeClasses, parseClasses, type ClassEntry } from "../core/classTable";
import type { Window } from "../core/grid";
import type { LabelStore } from "../core/labelStore";
import { cellBuckets, fillPreview, PREVIEW_MAX_SIDE, previewCells } from "../core/maskPreview";
import { countRaw, finishImport, maskVals, rawCounts } from "../core/rawCounts";
import { markValues, seedLut, seedWindows, sourceCells } from "../core/seed";
import type { ValidMask } from "../core/validMask";
import type { LabelSource } from "./labelFile";
import { gather, gridOf, type MaskBase } from "./maskBase";
import { MaskCache, STROKE } from "./maskCache";
import type { RasterSource } from "./source";

/** seedWindows (row-major) grouped by row. */
function rowsOf(windows: Window[]): Window[][] {
  const rows: Window[][] = [];
  for (const w of windows) {
    const last = rows[rows.length - 1];
    if (last && last[0]!.y0 === w.y0) last.push(w); else rows.push([w]);
  }
  return rows;
}

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

/** Imports a class raster as the mask base, by nearest pixel centre, masked by imagery nodata (specs 004, 014, 024). */
// One pass over the seedWindows, a row at a time: the file's values come from its row bands (each strip of an
// equal grid decoded once), imagery validity from the mask cache (the windows the file covers, at stroke priority,
// left cached for painting), and only raw counts and preview values are kept. Classes and the LUT follow the pass:
// the class map's, else the file's table, else every value met before masking, as spec 004's first pass found
// them. The file stays the base, read again on demand (ADR 0018). Every import replaces (spec 017).
// `stale` turns true when another raster opened or the user cancelled: the run stops and nothing changes.
// onProgress counts windows whose file values are read (spec 021): a row's masks follow its last window.
export async function importLabels(imagery: RasterSource, file: LabelSource, table: ClassEntry[] | null,
  stale: () => boolean = () => false, onProgress?: (done: number, total: number) => void,
  cache: MaskCache = new MaskCache(imagery)): Promise<SeedOutcome> {
  // with a table the classes are known now: "too many" before any read; from values, only after the pass
  const early = table && mergeClasses([], table);
  if (early === "too many") return early;
  const dst = gridOf(imagery.meta), src = gridOf(file.meta);
  const windows = seedWindows(dst, src);
  const counts = rawCounts(windows.length);
  const { cells, width, height, corners } = previewCells(dst, PREVIEW_MAX_SIDE);
  const buckets = cellBuckets(cells, dst);
  const raw = new Uint16Array(width * height); // raw value + 1; 0 for none
  const { nodata } = file.meta;
  let done = 0;
  for (const row of rowsOf(windows)) {
    const first = done, vals: Int16Array[] = [];
    for (const w of row) {
      const v = await gather(file, sourceCells(dst, src, w), w.width * w.height);
      if (stale()) return "stale";
      markValues(v, counts.seen);
      if (nodata !== null) for (let i = 0; i < v.length; i++) if (v[i] === nodata) v[i] = -1; // never a class: no imagery read for it
      vals.push(v);
      done++; // outside onProgress?.(), which skips its arguments with no listener
      onProgress?.(done, windows.length);
    }
    const covered = row.filter((_, i) => vals[i]!.some((v) => v >= 0));
    let masks: ValidMask[];
    try {
      masks = await rowMasks(cache, covered);
    } catch (e) {
      if (stale()) return "stale";
      throw e;
    }
    if (stale()) return "stale";
    row.forEach((w, i) => {
      const v = vals[i]!, k = covered.indexOf(w);
      if (k < 0) return;
      maskVals(masks[k]!, v);
      countRaw(v, counts, first + i);
      fillPreview(raw, cells, buckets, w, Uint16Array.from(v, (x) => x + 1));
    });
    // a row whose file bands are cached runs on microtasks alone: give the bar and Cancel a turn between rows
    await new Promise((r) => setTimeout(r, 0));
    if (stale()) return "stale";
  }
  const entries = table ?? classesFromValues(counts.seen, file.meta.nodata);
  const merged = early ?? mergeClasses([], entries);
  if (merged === "too many") return merged;
  const lut = seedLut(entries, merged.values);
  const r = finishImport(counts, lut, raw);
  if (!r.count) return "empty";
  const labelled = new Set(r.labelled.map((i) => `${windows[i]!.x0},${windows[i]!.y0}`));
  const base: MaskBase = { file, lut, count: r.count, windows: labelled, preview: { values: r.preview, width, height, corners, buckets } };
  return { store: { width: dst.width, height: dst.height, tiles: new Map(), base: true }, classes: merged.list, base, pixels: r.count, classCount: r.classCount };
}

/** The valid masks of one row's windows, read at stroke priority; a mask evicted before use is read once more. */
async function rowMasks(cache: MaskCache, row: Window[]): Promise<ValidMask[]> {
  if (!row.length) return [];
  for (let tries = 0; ; tries++) {
    await cache.need(row[0]!.y0, STROKE, row.map((w) => w.x0));
    const masks = row.map((w) => cache.get(`${w.x0},${w.y0}`));
    if (masks.every((m) => m !== undefined)) return masks as ValidMask[];
    if (tries === 1) throw new Error("The imagery's valid masks were evicted before the import could use them");
  }
}
