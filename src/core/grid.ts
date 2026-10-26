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

/** Grid windows whose area overlaps any [minCol, minRow, maxCol, maxRow] box. */
export function windowsIntersecting(width: number, height: number, boxes: [number, number, number, number][], size = TILE_SIZE): Window[] {
  return tileWindows(width, height, size).filter((w) =>
    boxes.some(([x0, y0, x1, y1]) => x1 > w.x0 && x0 < w.x0 + w.width && y1 > w.y0 && y0 < w.y0 + w.height));
}
