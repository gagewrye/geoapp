import { applyAffine, fromLonLat, invertAffine, normalizeLon, projString, toLonLat } from "./crs";
import type { Window } from "./grid";
import type { Grid } from "./types";

/** Brush sides in raster pixels (spec 017); odd only, so the square centres on the pointer's pixel. */
export const BRUSH_MIN = 1, BRUSH_MAX = 127, BRUSH_STEP = 2;
export const DEFAULT_BRUSH = 7;

/** The next brush side up (2s + 1) or down (2·floor((s - 1) / 4) + 1), within BRUSH_MIN..BRUSH_MAX; odd from odd. */
// From 7 these give spec 003's old fixed sizes 1, 3, 7, 15, 31, 63, 127 exactly.
export function stepBrush(side: number, dir: 1 | -1): number {
  return dir > 0 ? Math.min(BRUSH_MAX, 2 * side + 1) : Math.max(BRUSH_MIN, 2 * Math.floor((side - 1) / 4) + 1);
}

/** [col, row] of the pixel containing a lon/lat (floor); every world copy gives the same pixel; may be off the raster. */
export function pixelAt(grid: Grid, lon: number, lat: number): [number, number] {
  projString(grid.epsg); // an unsupported CRS throws even for 4326's shortcut path
  const [x, y] = fromLonLat(grid.epsg, normalizeLon(lon), lat);
  const [c, r] = invertAffine(grid.gt, x, y);
  return [Math.floor(c), Math.floor(r)];
}

/** The side x side square centred on (col, row), clipped to the raster; null when it misses. */
export function footprint(dims: Pick<Grid, "width" | "height">, col: number, row: number, side: number): Window | null {
  const h = (side - 1) / 2;
  const x0 = Math.max(0, col - h), y0 = Math.max(0, row - h);
  const x1 = Math.min(dims.width, col + h + 1), y1 = Math.min(dims.height, row + h + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

/** Lon/lat TL, TR, BR, BL, TL of a window's outer pixel edges. */
export function footprintRing(grid: Grid, w: Window): [number, number][] {
  const x1 = w.x0 + w.width, y1 = w.y0 + w.height;
  const corners: [number, number][] = [[w.x0, w.y0], [x1, w.y0], [x1, y1], [w.x0, y1], [w.x0, w.y0]];
  return corners.map(([c, r]) => toLonLat(grid.epsg, ...applyAffine(grid.gt, c, r)));
}

/** 8-connected Bresenham cells from a to b, both ends included: cell k is a + round(k * (b - a) / n). */
export function strokeCells(a: [number, number], b: [number, number]): [number, number][] {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  return cellRange(a, b, n, 0, n);
}

/** strokeCells(a, b) inside a box (bounds inclusive), visiting only steps that can land in it. */
// At low zoom one pointer move can span millions of off-raster pixels.
export function strokeCellsIn(a: [number, number], b: [number, number], box: { x0: number; y0: number; x1: number; y1: number }): [number, number][] {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  if (n === 0) return inBox(a, box) ? [[a[0], a[1]]] : [];
  // |round(t) - t| <= 0.5, so a step lands in [lo, hi] only if its exact position is within [lo - 0.5, hi + 0.5]
  let k0 = 0, k1 = n;
  for (const [p, d, lo, hi] of [[a[0], b[0] - a[0], box.x0, box.x1], [a[1], b[1] - a[1], box.y0, box.y1]] as const) {
    if (d === 0) { if (p < lo || p > hi) return []; continue; }
    const ka = ((lo - 0.5 - p) * n) / d, kb = ((hi + 0.5 - p) * n) / d;
    k0 = Math.max(k0, Math.floor(Math.min(ka, kb)) - 1);
    k1 = Math.min(k1, Math.ceil(Math.max(ka, kb)) + 1);
  }
  return k0 > k1 ? [] : cellRange(a, b, n, k0, k1).filter((c) => inBox(c, box));
}

const inBox = ([c, r]: [number, number], box: { x0: number; y0: number; x1: number; y1: number }) =>
  c >= box.x0 && c <= box.x1 && r >= box.y0 && r <= box.y1;

function cellRange(a: [number, number], b: [number, number], n: number, k0: number, k1: number): [number, number][] {
  const out: [number, number][] = [];
  const dc = b[0] - a[0], dr = b[1] - a[1];
  for (let k = k0; k <= k1; k++) {
    out.push(n === 0 ? [a[0], a[1]] : [a[0] + Math.round((k * dc) / n), a[1] + Math.round((k * dr) / n)]);
  }
  return out;
}
