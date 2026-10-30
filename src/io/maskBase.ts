import type { Window } from "../core/grid";
import { tileWindow, type LabelStore } from "../core/labelStore";
import type { MaskPreview } from "../core/maskPreview";
import { maskSamples } from "../core/alpha";
import { decimateInto } from "../core/decimate";
import { rowReads } from "../core/imagery";
import { maskLabels, type ValidMask } from "../core/validMask";
import { applyLut, gatherCells, maskNodata, nodataPossible, sourceCells } from "../core/seed";
import type { Grid, Tile } from "../core/types";
import type { LabelSource } from "./labelFile";
import type { ImagerySource, RasterMeta, RasterSource } from "./source";

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

/** Labels of imagery window w from the file alone: lut of the gathered file values. */
export const fileLabels = async (imagery: RasterSource, file: LabelSource, lut: Uint8Array, w: Window): Promise<Uint8Array> =>
  applyLut(await gather(file, sourceCells(gridOf(imagery.meta), gridOf(file.meta), w), w.width * w.height), lut);

/** Whether the imagery can mask a label at all: a nodata value, float samples or an alpha band (specs 021, 022). */
const canMask = ({ nodata, float, alpha }: RasterMeta) => nodataPossible(nodata, float, alpha !== null);

const f32 = (a: ArrayLike<number>) => (a instanceof Float32Array ? a : Float32Array.from(a));

/** Window w's samples for masking (maskSamples: the alpha sample alone when only alpha can be nodata), by readSamples when the source has it. */
async function maskTile(imagery: RasterSource, w: Window): Promise<Tile> {
  const { bandCount, nodata, float, alpha } = imagery.meta;
  const m = maskSamples(bandCount, nodata, float, alpha);
  if (imagery.readSamples) {
    const bands = await imagery.readSamples(0, w.x0, w.y0, w.width, w.height, m.samples);
    return { x0: w.x0, y0: w.y0, width: w.width, height: w.height, bands: bands.map(f32), nodata, alpha: m.alpha };
  }
  const t = await imagery.readWindow(w.x0, w.y0, w.width, w.height);
  return m.samples.length === t.bands.length ? t : { ...t, bands: m.samples.map((k) => t.bands[k]!), alpha: m.alpha };
}

/**
 * Spec 004's per-window import step: fileLabels, then maskNodata with the imagery window if any value is
 * non-zero and the imagery can mask one. Returns the imagery tile it read, if any; null when `stop` turns
 * true after the file reads (the imagery is then not read).
 */
export async function windowLabels(imagery: RasterSource, file: LabelSource, lut: Uint8Array, w: Window,
  stop: () => boolean = () => false): Promise<{ labels: Uint8Array; tile: Tile | null } | null> {
  const labels = await fileLabels(imagery, file, lut, w);
  if (stop()) return null;
  if (!anyNonZero(labels) || !canMask(imagery.meta)) return { labels, tile: null };
  const tile = await maskTile(imagery, w);
  maskNodata(tile, labels);
  return { labels, tile };
}

/** Rule R (spec 022): masks one row of seed windows' labels from reads of that row, each within MAX_READ_BYTES of decoded blocks. */
// One span from the first window needing imagery to the last, so a block (a 1-row strip, say) is decoded once
// per row; each window's samples are copied out of each read, and only this row's are held.
export async function maskRow(imagery: ImagerySource, row: { w: Window; labels: Uint8Array }[]): Promise<void> {
  const need = row.filter((x) => anyNonZero(x.labels));
  if (!need.length || !canMask(imagery.meta)) return;
  const { width, height, bandCount, nodata, float, alpha } = imagery.meta;
  const m = maskSamples(bandCount, nodata, float, alpha);
  const first = need[0]!.w, last = need[need.length - 1]!.w;
  const span = { x0: first.x0, y0: first.y0, width: last.x0 + last.width - first.x0, height: first.height };
  const tiles: Tile[] = need.map(({ w }) => ({ x0: w.x0, y0: w.y0, width: w.width, height: w.height, nodata, alpha: m.alpha,
    bands: m.samples.map(() => new Float32Array(w.width * w.height)) }));
  for (const r of rowReads([span], 1, imagery.block, width, height)) {
    const bands = await imagery.readSamples(0, r.x0, r.y0, r.width, r.height, m.samples);
    for (const t of tiles) decimateInto(t, { ...r, bands }, 1, width, height);
  }
  need.forEach((x, i) => maskNodata(tiles[i]!, x.labels));
}

/** The mask's tile for window w, and the imagery tile read for it if any; reads nothing for a window the mask leaves empty. */
export async function baseTile(imagery: RasterSource, base: MaskBase, w: Window): Promise<{ labels: Uint8Array; tile: Tile | null }> {
  if (!base.windows.has(`${w.x0},${w.y0}`)) return { labels: new Uint8Array(w.width * w.height), tile: null };
  return (await windowLabels(imagery, base.file, base.lut, w))!;
}

/** baseTile masked by a cached valid mask instead of an imagery read (spec 023 F4): reads only the label file. */
export async function maskedBaseTile(imagery: RasterSource, base: MaskBase, w: Window, mask: ValidMask): Promise<Uint8Array> {
  if (!base.windows.has(`${w.x0},${w.y0}`)) return new Uint8Array(w.width * w.height);
  const labels = await fileLabels(imagery, base.file, base.lut, w);
  maskLabels(mask, labels);
  return labels;
}

/** The labels window w shows: its stored tile, else the mask's tile, else zeros. */
export async function effectiveTile(imagery: RasterSource, store: LabelStore, base: MaskBase | null, w: Window): Promise<Uint8Array> {
  const stored = store.tiles.get(`${w.x0},${w.y0}`);
  if (stored) return stored;
  return base ? (await baseTile(imagery, base, w)).labels : new Uint8Array(w.width * w.height);
}
