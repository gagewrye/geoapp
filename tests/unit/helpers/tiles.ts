import type { Tile } from "../../../src/core/types";

/** Tile whose band k holds f(k, col, row) at global raster coordinates. */
export function makeTile(x0: number, y0: number, width: number, height: number, nb: number,
  f: (band: number, col: number, row: number) => number, nodata: number | null = null): Tile {
  const bands = Array.from({ length: nb }, (_, k) => {
    const a = new Float32Array(width * height);
    for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) a[r * width + c] = f(k, x0 + c, y0 + r);
    return a;
  });
  return { x0, y0, width, height, bands, nodata };
}

/** Coordinates helper: band 0 = col, band 1 = row. */
export const colRow = (k: number, c: number, r: number) => (k === 0 ? c : k === 1 ? r : c * 100 + r);
