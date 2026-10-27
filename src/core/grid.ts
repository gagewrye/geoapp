import { TILE_SIZE } from "./types";

export type Window = { x0: number; y0: number; width: number; height: number };

/** Row-major output tile grid; edge windows are clipped to the raster. */
export function tileWindows(width: number, height: number, size = TILE_SIZE): Window[] {
  const out: Window[] = [];
  for (let y0 = 0; y0 < height; y0 += size)
    for (let x0 = 0; x0 < width; x0 += size)
      out.push({ x0, y0, width: Math.min(size, width - x0), height: Math.min(size, height - y0) });
  return out;
}
