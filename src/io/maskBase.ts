import type { Window } from "../core/grid";
import { tileWindow, type LabelStore } from "../core/labelStore";
import type { MaskPreview } from "../core/maskPreview";
import { applyLut, gatherCells, maskNodata, nodataPossible, sourceCells } from "../core/seed";
import type { Grid, Tile } from "../core/types";
import type { LabelSource } from "./labelFile";
import type { RasterSource } from "./source";

/** An imported label mask (spec 014, ADR 0018): the user's file, read on demand as a read-only base under the edit tiles. */
// windows: keys of the seedWindows that hold a labelled pixel; every other window's base tile is all zeros.
export type MaskBase = { file: LabelSource; lut: Uint8Array; count: number; windows: Set<string>; preview: MaskPreview };

export const gridOf = (m: { width: number; height: number; epsg: number; gt: Grid["gt"] }): Grid => ({ width: m.width, height: m.height, epsg: m.epsg, gt: m.gt });

/** File values at each pixel of imagery window w (-1 off the file), reading the file's 256x256 windows that hold a cell, one at a time. */
export async function gather(file: LabelSource, cells: Int32Array, n: number): Promise<Int16Array> {
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

export const anyNonZero = (a: Uint8Array) => a.some((v) => v !== 0);

/**
 * Spec 004's per-window import step: lut of the gathered file values, then maskNodata with the imagery
 * window if any value is non-zero and the imagery can hold nodata (spec 021: a later spec honouring alpha
 * must add "or an alpha band" to that condition). Returns the imagery tile it read, if any; null when `stop` turns true
 * after the file reads (the imagery is then not read).
 */
export async function windowLabels(imagery: RasterSource, file: LabelSource, lut: Uint8Array, w: Window,
  stop: () => boolean = () => false): Promise<{ labels: Uint8Array; tile: Tile | null } | null> {
  const labels = applyLut(await gather(file, sourceCells(gridOf(imagery.meta), gridOf(file.meta), w), w.width * w.height), lut);
  if (stop()) return null;
  const { nodata, float } = imagery.meta;
  if (!anyNonZero(labels) || !nodataPossible(nodata, float)) return { labels, tile: null };
  const tile = await imagery.readWindow(w.x0, w.y0, w.width, w.height);
  maskNodata(tile, labels);
  return { labels, tile };
}

/** The mask's tile for window w, and the imagery tile read for it if any; reads nothing for a window the mask leaves empty. */
export async function baseTile(imagery: RasterSource, base: MaskBase, w: Window): Promise<{ labels: Uint8Array; tile: Tile | null }> {
  if (!base.windows.has(`${w.x0},${w.y0}`)) return { labels: new Uint8Array(w.width * w.height), tile: null };
  return (await windowLabels(imagery, base.file, base.lut, w))!;
}

/** The labels window w shows: its stored tile, else the mask's tile, else zeros. */
export async function effectiveTile(imagery: RasterSource, store: LabelStore, base: MaskBase | null, w: Window): Promise<Uint8Array> {
  const stored = store.tiles.get(`${w.x0},${w.y0}`);
  if (stored) return stored;
  return base ? (await baseTile(imagery, base, w)).labels : new Uint8Array(w.width * w.height);
}
