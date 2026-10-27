import { applyAffine, fromLonLat, invertAffine, normalizeLon, projString, toLonLat } from "./crs";
import type { Window } from "./grid";
import type { Grid } from "./types";

/** Brush sides in raster pixels; odd, so the square centres on the pointer's pixel. */
export const BRUSH_SIZES = [1, 3, 7, 15, 31, 63, 127] as const;
export const DEFAULT_BRUSH = 7;

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

/** 8-connected Bresenham cells from a to b, both ends included. */
export function strokeCells(a: [number, number], b: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  let [c, r] = a;
  const dc = Math.abs(b[0] - c), dr = -Math.abs(b[1] - r);
  const sc = c < b[0] ? 1 : -1, sr = r < b[1] ? 1 : -1;
  let err = dc + dr;
  for (;;) {
    out.push([c, r]);
    if (c === b[0] && r === b[1]) return out;
    const e2 = 2 * err;
    if (e2 >= dr) { err += dr; c += sc; }
    if (e2 <= dc) { err += dc; r += sr; }
  }
}
