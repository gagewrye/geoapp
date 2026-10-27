import { badClassName, type LabelClass } from "../core/classes";
import { classesFromValues, ClassTableError, decodeClasses, mergeClasses, parseClasses, type ClassEntry } from "../core/classTable";
import { tileWindows, type Window } from "../core/grid";
import { emptyStore, putTile, tileWindow, type LabelStore } from "../core/labelStore";
import { seedFromModel } from "../core/predict";
import { applyLut, gatherCells, markValues, maskNodata, mergeTile, seedLut, seedWindows, sourceCells } from "../core/seed";
import type { Grid, Model } from "../core/types";
import type { LabelSource } from "./labelFile";
import type { RasterSource } from "./source";

/** A label store and its class list (label value = index + 1). */
export type Labels = { store: LabelStore; classes: LabelClass[] };
/** Merge fills only unlabelled pixels; Replace starts from no labels and no classes. */
export type SeedMode = "merge" | "replace";
/** The new labels, the pixels the seed labelled and their class count; or why nothing changed. */
export type SeedOutcome = (Labels & { pixels: number; classCount: number }) | "full" | "too many" | "empty" | "bad names" | "stale";

const gridOf = (m: { width: number; height: number; epsg: number; gt: Grid["gt"] }): Grid => ({ width: m.width, height: m.height, epsg: m.epsg, gt: m.gt });

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

/** File values at each pixel of imagery window w (-1 off the file), reading the file's 256x256 windows that hold a cell, one at a time. */
async function gather(file: LabelSource, cells: Int32Array, n: number): Promise<Int16Array> {
  const keys = new Set<number>();
  for (let i = 0; i < n; i++) {
    const c = cells[2 * i]!;
    if (c >= 0) keys.add((cells[2 * i + 1]! >> 8) * 65536 + (c >> 8));
  }
  const vals = new Int16Array(n).fill(-1);
  for (const k of [...keys].sort((a, b) => a - b)) {
    const fw = tileWindow(file.meta, (k % 65536) * 256, Math.floor(k / 65536) * 256);
    gatherCells(cells, fw, await file.read(fw), vals);
  }
  return vals;
}

/**
 * Builds new labels from per-window seeds (null when a window seeds nothing) without touching
 * `current`: Merge starts from a shallow copy of its store and list, Replace from neither. Each
 * seeded window's tile becomes mergeTile(new tile, seed).
 */
async function build(windows: Window[], current: Labels, mode: SeedMode, incoming: { name: string; colour?: string }[],
  seed: (w: Window, values: number[]) => Promise<Uint8Array | null>, stale: () => boolean): Promise<SeedOutcome> {
  const merged = mergeClasses(mode === "merge" ? current.classes : [], incoming);
  if (merged === "too many") return merged;
  const { width, height } = current.store;
  const store: LabelStore = mode === "merge" ? { width, height, tiles: new Map(current.store.tiles) } : emptyStore(width, height);
  let pixels = 0;
  const seen = new Set<number>();
  for (const w of windows) {
    const s = await seed(w, merged.values);
    if (stale()) return "stale";
    if (!s) continue;
    const old = store.tiles.get(`${w.x0},${w.y0}`);
    for (let i = 0; i < s.length; i++) if (s[i] && !old?.[i]) { pixels++; seen.add(s[i]!); }
    if (putTile(store, w, mergeTile(old, s)) === "full") return "full";
  }
  if (!pixels) return "empty";
  return { store, classes: merged.list, pixels, classCount: seen.size };
}

const anyNonZero = (a: Uint8Array) => a.some((v) => v !== 0);

/**
 * Imports a class raster onto the imagery grid by nearest pixel centre, masked by imagery nodata
 * (spec 004). A null table takes classes from the values first (a pass that reads no imagery).
 * Each pass visits every seedWindows window once; imagery is read only where a label would land.
 * `stale` turns true when another raster opened: the run stops and changes nothing.
 */
export async function importLabels(imagery: RasterSource, file: LabelSource, table: ClassEntry[] | null, current: Labels,
  mode: SeedMode, stale: () => boolean = () => false): Promise<SeedOutcome> {
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
  const named = entries;
  let lut: Uint8Array | null = null;
  return build(windows, current, mode, named, async (w, values) => {
    lut ??= seedLut(named, values);
    const labels = applyLut(await gather(file, sourceCells(dst, src, w), w.width * w.height), lut);
    if (!anyNonZero(labels) || stale()) return null;
    maskNodata(await imagery.readWindow(w.x0, w.y0, w.width, w.height), labels);
    return anyNonZero(labels) ? labels : null;
  }, stale);
}

/** Seeds labels from a model's predictions where its max softmax is at least minProb, masked by imagery nodata (spec 004). */
// Every imagery window is read once; the incoming classes are model.classes, without colours.
// A model whose names spec 003 refuses reads nothing: its list wouldn't export and import back the same.
export async function seedModel(imagery: RasterSource, model: Model, minProb: number, current: Labels,
  mode: SeedMode, stale: () => boolean = () => false): Promise<SeedOutcome> {
  if (badClassName(model.classes) !== null) return "bad names";
  const { width, height } = imagery.meta;
  return build(tileWindows(width, height), current, mode, model.classes.map((name) => ({ name })), async (w, values) => {
    const tile = await imagery.readWindow(w.x0, w.y0, w.width, w.height);
    const labels = seedFromModel(model, tile, minProb, values);
    maskNodata(tile, labels);
    return anyNonZero(labels) ? labels : null;
  }, stale);
}
