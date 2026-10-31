import type { Window } from "./grid";

/** The label at raster pixel (col, row) of a tile laid out row-major over w (spec 038). */
export function labelAt(tile: Uint8Array, w: Window, col: number, row: number): number {
  const c = col - w.x0, r = row - w.y0;
  if (c < 0 || r < 0 || c >= w.width || r >= w.height) throw new RangeError(`pixel ${col},${row} is outside the window at ${w.x0},${w.y0}`);
  return tile[r * w.width + c]!;
}
