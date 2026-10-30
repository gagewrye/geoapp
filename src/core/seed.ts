import type { ClassEntry } from "./classTable";
import { applyAffine, fromLonLat, invertAffine, normalizeLon, toLonLat } from "./crs";
import { tileWindows, type Window } from "./grid";
import { pixelAt } from "./pixel";
import type { Grid, Tile } from "./types";

/** Seeding labels from a class raster on another grid (spec 004): nearest pixel centre, then masks and LUTs. */

// Pixel sizes and rotations this close are equal, and an origin this close to a whole pixel is on it: the
// offset path then picks the pixel the projection would, since every centre is 0.5 px from a pixel edge.
const SAME_SIZE = 1e-9, WHOLE_PIXEL = 1e-6;

/** [dx, dy] when src is dst's grid shifted by whole pixels (src pixel c, r is dst pixel c + dx, r + dy); else null. */
export function gridOffset(dst: Grid, src: Grid): [number, number] | null {
  if (dst.epsg !== src.epsg) return null;
  const scale = Math.max(Math.abs(dst.gt[1]), Math.abs(dst.gt[5]));
  for (const k of [1, 2, 4, 5] as const) if (Math.abs(dst.gt[k] - src.gt[k]) > SAME_SIZE * scale) return null;
  const [dx, dy] = invertAffine(dst.gt, src.gt[0], src.gt[3]);
  const rx = Math.round(dx) + 0, ry = Math.round(dy) + 0; // + 0: no -0
  return Math.abs(dx - rx) <= WHOLE_PIXEL && Math.abs(dy - ry) <= WHOLE_PIXEL ? [rx, ry] : null;
}

/** Per pixel of w, row-major: col, row of the src pixel holding its centre, or -1, -1 off src. */
// Spec 005's transfer at k = 1: dst gt, then core/crs to lon/lat, then pixelAt(src). Equal CRSs skip
// the lon/lat round trip, which would only add rounding; equal grids (spec 024) skip projecting at all.
export function sourceCells(dst: Grid, src: Grid, w: Window): Int32Array {
  const out = new Int32Array(2 * w.width * w.height);
  const offset = gridOffset(dst, src);
  if (offset) return offsetCells(src, w, offset, out);
  const same = dst.epsg === src.epsg;
  let i = 0;
  for (let r = w.y0; r < w.y0 + w.height; r++) {
    for (let c = w.x0; c < w.x0 + w.width; c++) {
      const [x, y] = applyAffine(dst.gt, c + 0.5, r + 0.5);
      let col: number, row: number;
      if (same) {
        const [fc, fr] = invertAffine(src.gt, x, y);
        col = Math.floor(fc); row = Math.floor(fr);
      } else {
        [col, row] = pixelAt(src, ...toLonLat(dst.epsg, x, y));
      }
      const on = col >= 0 && col < src.width && row >= 0 && row < src.height; // false for NaN too
      out[i++] = on ? col : -1;
      out[i++] = on ? row : -1;
    }
  }
  return out;
}

function offsetCells(src: Grid, w: Window, [dx, dy]: [number, number], out: Int32Array): Int32Array {
  let i = 0;
  for (let r = w.y0 - dy; r < w.y0 + w.height - dy; r++) {
    for (let c = w.x0 - dx; c < w.x0 + w.width - dx; c++) {
      const on = c >= 0 && c < src.width && r >= 0 && r < src.height;
      out[i++] = on ? c : -1;
      out[i++] = on ? r : -1;
    }
  }
  return out;
}

const EDGE_STEPS = 64;

/** src pixel coordinates to dst pixel coordinates, by the forward path. */
function toDst(dst: Grid, src: Grid, col: number, row: number): [number, number] {
  const [x, y] = applyAffine(src.gt, col, row);
  if (dst.epsg === src.epsg) return invertAffine(dst.gt, x, y);
  const [lon, lat] = toLonLat(src.epsg, x, y);
  return invertAffine(dst.gt, ...fromLonLat(dst.epsg, normalizeLon(lon), lat));
}

/** dst tileWindows that can hold a pixel centre on src, row-major; may over-include, never misses. */
// The image of src's outline bounds the image of src. Between outline samples the curve can sag, so
// the box grows by the longest sample step plus a pixel; a non-finite sample keeps every window.
export function seedWindows(dst: Grid, src: Grid): Window[] {
  const all = tileWindows(dst.width, dst.height);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, step = 0;
  let prev: [number, number] | null = null;
  const corners: [number, number][] = [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height], [0, 0]];
  for (let e = 0; e < 4; e++) {
    const [ac, ar] = corners[e]!, [bc, br] = corners[e + 1]!;
    for (let s = 0; s <= EDGE_STEPS; s++) {
      const t = s / EDGE_STEPS;
      const p = toDst(dst, src, ac + (bc - ac) * t, ar + (br - ar) * t);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return all;
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      if (prev) step = Math.max(step, Math.hypot(p[0] - prev[0], p[1] - prev[1]));
      prev = p;
    }
  }
  const pad = step + 1;
  return all.filter((w) => w.x0 < x1 + pad && w.x0 + w.width > x0 - pad && w.y0 < y1 + pad && w.y0 + w.height > y0 - pad);
}

/** out[i] = data at cell i when the cell is inside src window sw (data row-major for sw); else untouched. */
export function gatherCells(cells: Int32Array, sw: Window, data: Uint8Array, out: Int16Array): void {
  const cx1 = sw.x0 + sw.width, ry1 = sw.y0 + sw.height;
  for (let i = 0; i < out.length; i++) {
    const c = cells[2 * i]!, r = cells[2 * i + 1]!;
    if (c >= sw.x0 && c < cx1 && r >= sw.y0 && r < ry1) out[i] = data[(r - sw.y0) * sw.width + (c - sw.x0)]!;
  }
}

/** seen[v] = 1 for every gathered value v >= 0 (seen has 256 entries). */
export function markValues(vals: Int16Array, seen: Uint8Array): void {
  for (const v of vals) if (v >= 0) seen[v] = 1;
}

/** 256 entries: entries[i].value -> values[i]; unlisted values -> 0 (unlabelled). */
export function seedLut(entries: ClassEntry[], values: number[]): Uint8Array {
  const lut = new Uint8Array(256);
  entries.forEach((e, i) => { lut[e.value] = values[i]!; });
  return lut;
}

/** Label values of gathered file values; -1 (off the file) -> 0. */
export function applyLut(vals: Int16Array, lut: Uint8Array): Uint8Array {
  const out = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) { const v = vals[i]!; if (v >= 0) out[i] = lut[v]!; }
  return out;
}

/** Whether maskNodata can clear a label: only with a nodata value, floating-point samples (NaN) or an alpha band (spec 022). */
export const nodataPossible = (nodata: number | null, float: boolean, alpha = false): boolean => nodata !== null || float || alpha;

/** labels[i] = 0 where any band equals tile.nodata or is NaN (spec 001's rule over all bands), or alpha is 0 (spec 022). */
export function maskNodata(tile: Tile, labels: Uint8Array): void {
  if (labels.length !== tile.width * tile.height) throw new Error(`maskNodata: ${labels.length} labels for a ${tile.width}x${tile.height} tile`);
  const { nodata } = tile;
  for (const band of tile.bands) for (let i = 0; i < labels.length; i++) { const v = band[i]!; if (v === nodata || v !== v) labels[i] = 0; }
  const a = tile.alpha == null ? undefined : tile.bands[tile.alpha];
  if (a) for (let i = 0; i < labels.length; i++) if (a[i] === 0) labels[i] = 0;
}
