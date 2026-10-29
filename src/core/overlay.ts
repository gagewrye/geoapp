import { applyAffine, fromLonLat, invertAffine, toLonLat } from "./crs";
import { tileWindows, type Window } from "./grid";
import { TILE_SIZE, type Grid } from "./types";
import { MERC_MAX_Y, latOf, lonOf, mercBounds, mercator } from "./warp";

/** Sample stride, raster px, when sizing the overlay grid (spec 011). */
export const OVERLAY_SAMPLE = 16;
/** Cells are this fraction of the narrowest sampled pixel, so sampling can't miss a pixel. */
export const OVERLAY_MARGIN = 0.98;

/** Base cell size px, py (Mercator m) and each tile's power-of-two multiples, by LabelStore key. */
export type OverlayGrid = { px: number; py: number; k: Map<string, [number, number]> };

const merc = (g: Grid, c: number, r: number) => mercator(...toLonLat(g.epsg, ...applyAffine(g.gt, c, r)));
const keyOf = (c: number, r: number) => `${Math.floor(c / TILE_SIZE) * TILE_SIZE},${Math.floor(r / TILE_SIZE) * TILE_SIZE}`;

/** Mercator widths [wx, wy] of an axis-aligned box inside pixel (col, row); null unless it is wholly within ±MAX_LAT. */
export function pixelWidths(grid: Grid, col: number, row: number): [number, number] | null {
  const m = merc(grid, col, row), p = merc(grid, col + 1, row), q = merc(grid, col, row + 1);
  const ax = p[0] - m[0], ay = p[1] - m[1], bx = q[0] - m[0], by = q[1] - m[1];
  // the fourth corner as the parallelogram's, so a sample costs three projections
  for (const y of [m[1], p[1], q[1], m[1] + ay + by]) if (!(Math.abs(y) <= MERC_MAX_Y)) return null;
  const cross = Math.abs(ax * by - ay * bx);
  return [cross / (Math.abs(ay) + Math.abs(by)), cross / (Math.abs(ax) + Math.abs(bx))];
}

/** Columns (or rows) x0, x0 + OVERLAY_SAMPLE, ... and the last one of a span of n. */
function samples(x0: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += OVERLAY_SAMPLE) out.push(x0 + i);
  if (out[out.length - 1] !== x0 + n - 1) out.push(x0 + n - 1);
  return out;
}

/** The raster's overlay grid, sized to its finest sampled pixel (ADR 0016); run once when the raster opens. */
export function overlayGrid(grid: Grid): OverlayGrid {
  const mins = new Map<string, [number, number]>();
  let gx = Infinity, gy = Infinity;
  for (const w of tileWindows(grid.width, grid.height)) {
    let tx = Infinity, ty = Infinity;
    for (const r of samples(w.y0, w.height)) for (const c of samples(w.x0, w.width)) {
      const pw = pixelWidths(grid, c, r);
      if (pw) { tx = Math.min(tx, pw[0]); ty = Math.min(ty, pw[1]); }
    }
    mins.set(`${w.x0},${w.y0}`, [tx, ty]);
    gx = Math.min(gx, tx); gy = Math.min(gy, ty);
  }
  if (!Number.isFinite(gx)) {
    // no pixel within MAX_LAT: nothing can show, so any finite grid does
    const [x0, y0, x1, y1] = mercBounds(tileWindows(grid.width, grid.height)[0]!, grid.gt, grid.epsg);
    gx = gy = Math.max(x1 - x0, y1 - y0, 1) / TILE_SIZE / OVERLAY_MARGIN;
  }
  const px = OVERLAY_MARGIN * gx, py = OVERLAY_MARGIN * gy;
  // the largest power of two with k * p <= OVERLAY_MARGIN * the tile's own minimum; the epsilon absorbs rounding at k = 1
  const pow = (t: number, p: number) => (Number.isFinite(t) ? 2 ** Math.max(0, Math.floor(Math.log2((OVERLAY_MARGIN * t) / p) + 1e-9)) : 1);
  const k = new Map<string, [number, number]>();
  for (const [key, [tx, ty]] of mins) k.set(key, [pow(tx, px), pow(ty, py)]);
  return { px, py, k };
}

/** True when convex quad q (raster coords) meets window w (separating axis test). */
function meets(q: [number, number][], w: Window): boolean {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  if (Math.max(...xs) < w.x0 || Math.min(...xs) > w.x0 + w.width || Math.max(...ys) < w.y0 || Math.min(...ys) > w.y0 + w.height) return false;
  const rect: [number, number][] = [[w.x0, w.y0], [w.x0 + w.width, w.y0], [w.x0 + w.width, w.y0 + w.height], [w.x0, w.y0 + w.height]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i]!, [bx, by] = q[(i + 1) % 4]!;
    const nx = ay - by, ny = bx - ax;
    const proj = (p: [number, number]) => p[0] * nx + p[1] * ny;
    const qs = q.map(proj), rs = rect.map(proj);
    if (Math.max(...qs) < Math.min(...rs) || Math.max(...rs) < Math.min(...qs)) return false;
  }
  return true;
}

/**
 * Tile w's overlay on og: cells kx*px by ky*py with edges at multiples from Mercator (0, 0). A cell is valid
 * (bit i of `valid`) when its centre is in w, indexing that pixel, or when it meets w and its centre is in a
 * neighbour with smaller cells, indexing w's nearest pixel. Corners lon/lat TL, TR, BR, BL.
 */
export function overlayIndex(w: Window, grid: Grid, og: OverlayGrid) {
  const [kx, ky] = og.k.get(`${w.x0},${w.y0}`) ?? [1, 1];
  const cx = kx * og.px, cy = ky * og.py;
  const [mx0, my0, mx1, my1] = mercBounds(w, grid.gt, grid.epsg);
  const u0 = Math.floor(mx0 / cx), t0 = Math.floor(my0 / cy);
  const width = Math.max(1, Math.ceil(mx1 / cx) - u0), height = Math.max(1, Math.ceil(my1 / cy) - t0);
  const t1 = t0 + height;
  const index = new Uint16Array(width * height), valid = new Uint8Array(Math.ceil((width * height) / 8));
  const toRaster = (x: number, y: number) => invertAffine(grid.gt, ...fromLonLat(grid.epsg, lonOf(x), latOf(y)));
  // the coarser tile covers a seam with a finer neighbour (spec 011 Who paints a cell)
  const finer = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= grid.width || r >= grid.height) return false;
    const nk = og.k.get(keyOf(c, r));
    return nk !== undefined && (nk[0] < kx || nk[1] < ky);
  };
  for (let v = 0; v < height; v++) {
    const yTop = (t1 - v) * cy, y = yTop - cy / 2;
    for (let u = 0; u < width; u++) {
      const xLeft = (u0 + u) * cx;
      const [c, r] = toRaster(xLeft + cx / 2, y);
      let i = Math.floor(c), j = Math.floor(r);
      const inside = i >= w.x0 && i < w.x0 + w.width && j >= w.y0 && j < w.y0 + w.height;
      if (!inside) {
        if (!finer(i, j)) continue;
        const quad = [toRaster(xLeft, yTop), toRaster(xLeft + cx, yTop), toRaster(xLeft + cx, yTop - cy), toRaster(xLeft, yTop - cy)];
        if (!meets(quad, w)) continue;
        i = Math.min(Math.max(i, w.x0), w.x0 + w.width - 1);
        j = Math.min(Math.max(j, w.y0), w.y0 + w.height - 1);
      }
      const o = v * width + u;
      index[o] = (j - w.y0) * w.width + (i - w.x0);
      valid[o >> 3]! |= 1 << (o & 7);
    }
  }
  const W = lonOf(u0 * cx), E = lonOf((u0 + width) * cx), N = latOf(t1 * cy), S = latOf(t0 * cy);
  const corners: [number, number][] = [[W, N], [E, N], [E, S], [W, S]];
  return { index, valid, width, height, corners };
}

/** A valid cell with label v > 0 gets colours[v - 1] ("#rrggbb") at alpha 255; everything else is transparent. */
export function paintOverlay(index: Uint16Array, valid: Uint8Array, labels: Uint8Array, colours: string[], rgba: Uint8ClampedArray): void {
  const rgb = colours.map((c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)));
  for (let p = 0; p < index.length; p++) {
    const v = (valid[p >> 3]! >> (p & 7)) & 1 ? labels[index[p]!]! : 0;
    const o = 4 * p;
    const col = v > 0 ? rgb[v - 1] : undefined;
    if (!col) { rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 0; continue; }
    rgba[o] = col[0]!; rgba[o + 1] = col[1]!; rgba[o + 2] = col[2]!; rgba[o + 3] = 255;
  }
}
