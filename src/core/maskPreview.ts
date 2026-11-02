import type { Window } from "./grid";
import { TILE_SIZE, type Grid } from "./types";
import { mercatorGrid } from "./warp";

/** Longest side of the imagery and mask previews, px. */
export const PREVIEW_MAX_SIDE = 1024;

/** Per preview pixel, row-major: col, row of the raster pixel holding its centre, or -1, -1; corners lon/lat TL, TR, BR, BL. */
// The same axis-aligned Mercator grid warpPreview uses, fitted to the whole raster, longest side maxSide.
export function previewCells(grid: Grid, maxSide: number): { cells: Int32Array; width: number; height: number; corners: [number, number][] } {
  const { width, height, corners, each } = mercatorGrid({ x0: 0, y0: 0, width: grid.width, height: grid.height }, grid.gt, grid.epsg, maxSide);
  const cells = new Int32Array(2 * width * height);
  each((o, c, r) => {
    const i = Math.floor(c), j = Math.floor(r);
    const on = i >= 0 && i < grid.width && j >= 0 && j < grid.height; // false for NaN too
    cells[2 * o] = on ? i : -1;
    cells[2 * o + 1] = on ? j : -1;
  });
  return { cells, width, height, corners };
}

/** Preview pixels grouped by the tile window holding their cell: window wi's pixels are order[start[wi]..start[wi + 1]). */
export type CellBuckets = { across: number; start: Int32Array; order: Int32Array };

/** The mask at preview resolution: label values per preview pixel, its Mercator corners, and its pixels by tile window. */
export type MaskPreview = { values: Uint8Array; width: number; height: number; corners: [number, number][]; buckets: CellBuckets };

/** Row-major index of the tile window with origin (x0, y0) among tileWindows(). */
export const windowIndex = (b: Pick<CellBuckets, "across">, x0: number, y0: number) => (y0 / TILE_SIZE) * b.across + x0 / TILE_SIZE;

/** Buckets preview pixels by tile window (a counting sort), so a window touches only its own pixels; off-raster pixels are left out. */
export function cellBuckets(cells: Int32Array, dims: Pick<Grid, "width" | "height">): CellBuckets {
  const across = Math.ceil(dims.width / TILE_SIZE), n = across * Math.ceil(dims.height / TILE_SIZE);
  const wi = (p: number) => Math.floor(cells[2 * p + 1]! / TILE_SIZE) * across + Math.floor(cells[2 * p]! / TILE_SIZE);
  const start = new Int32Array(n + 1);
  const count = cells.length / 2;
  let on = 0;
  for (let p = 0; p < count; p++) if (cells[2 * p]! >= 0) { start[wi(p) + 1]!++; on++; }
  for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
  const next = start.slice(0, n), order = new Int32Array(on);
  for (let p = 0; p < count; p++) if (cells[2 * p]! >= 0) order[next[wi(p)]!++] = p;
  return { across, start, order };
}

/** values[p] = the label (or raw value) under preview pixel p, for every p whose cell lies in window w (labels row-major for w). */
export function fillPreview(values: Uint8Array | Uint16Array, cells: Int32Array, b: CellBuckets, w: Window, labels: ArrayLike<number>): void {
  const wi = windowIndex(b, w.x0, w.y0);
  for (let k = b.start[wi]!; k < b.start[wi + 1]!; k++) {
    const p = b.order[k]!;
    values[p] = labels[(cells[2 * p + 1]! - w.y0) * w.width + (cells[2 * p]! - w.x0)]!;
  }
}

/** values[p] = base[p], or 0 without a base, for every preview pixel p whose cell lies in the window with origin (x0, y0): fillPreview undone. */
export function unfillPreview(values: Uint8Array, base: Uint8Array | null, b: CellBuckets, x0: number, y0: number): void {
  const wi = windowIndex(b, x0, y0);
  for (let k = b.start[wi]!; k < b.start[wi + 1]!; k++) {
    const p = b.order[k]!;
    values[p] = base ? base[p]! : 0;
  }
}

/** hidden[p] = on for every preview pixel p whose cell lies in the window with origin (x0, y0). */
export function hideWindow(hidden: Uint8Array, b: CellBuckets, x0: number, y0: number, on: boolean): void {
  const wi = windowIndex(b, x0, y0);
  for (let k = b.start[wi]!; k < b.start[wi + 1]!; k++) hidden[b.order[k]!] = on ? 1 : 0;
}

/** colours[v - 1] at alpha 255 where values[i] = v > 0 and hidden[i] = 0; else alpha 0. */
export function paintPreview(values: Uint8Array, hidden: Uint8Array, colours: string[], rgba: Uint8ClampedArray): void {
  const rgb = colours.map((c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)));
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!, o = 4 * i;
    const col = v > 0 && !hidden[i] ? rgb[v - 1] : undefined;
    if (!col) { rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 0; continue; }
    rgba[o] = col[0]!; rgba[o + 1] = col[1]!; rgba[o + 2] = col[2]!; rgba[o + 3] = 255;
  }
}
