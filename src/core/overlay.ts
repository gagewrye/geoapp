import { fromLonLat, invertAffine } from "./crs";
import { tileWindows, type Window } from "./grid";
import { TILE_SIZE, type Grid } from "./types";
import { latOf, lonOf, mercBounds } from "./warp";

/** Mercator metres per overlay pixel: the longest Mercator bbox side over every tile window / TILE_SIZE. */
// One pitch per raster puts every overlay on one grid (spec 011, ADR 0016). Taking the maximum over every
// tile, with the same clamped bbox overlayIndex uses, keeps each overlay within TILE_SIZE + 2 px a side.
export function overlayPitch(grid: Grid): number {
  let side = 0;
  for (const w of tileWindows(grid.width, grid.height)) {
    const [mx0, my0, mx1, my1] = mercBounds(w, grid.gt, grid.epsg);
    side = Math.max(side, mx1 - mx0, my1 - my0);
  }
  return side / TILE_SIZE;
}

/**
 * Per overlay pixel, the index into w's tile of the raster pixel holding its centre, or -1. Pixel edges
 * lie at multiples of pitch from Mercator (0, 0), so overlays of one raster partition the pixels; corners TL, TR, BR, BL.
 */
export function overlayIndex(w: Window, grid: Grid, pitch: number) {
  const [mx0, my0, mx1, my1] = mercBounds(w, grid.gt, grid.epsg);
  // every cell meeting the bbox, so a centre the densified bbox misses by under half a cell is still covered
  const u0 = Math.floor(mx0 / pitch), t0 = Math.floor(my0 / pitch);
  const width = Math.max(1, Math.ceil(mx1 / pitch) - u0), height = Math.max(1, Math.ceil(my1 / pitch) - t0);
  const t1 = t0 + height;
  const index = new Int32Array(width * height).fill(-1);
  for (let v = 0; v < height; v++) {
    const lat = latOf((t1 - v - 0.5) * pitch);
    for (let u = 0; u < width; u++) {
      const [c, r] = invertAffine(grid.gt, ...fromLonLat(grid.epsg, lonOf((u0 + u + 0.5) * pitch), lat));
      const i = Math.floor(c - w.x0), j = Math.floor(r - w.y0);
      if (i >= 0 && i < w.width && j >= 0 && j < w.height) index[v * width + u] = j * w.width + i;
    }
  }
  const W = lonOf(u0 * pitch), E = lonOf((u0 + width) * pitch), N = latOf(t1 * pitch), S = latOf(t0 * pitch);
  const corners: [number, number][] = [[W, N], [E, N], [E, S], [W, S]];
  return { index, width, height, corners };
}

/** Label v > 0 gets colours[v - 1] ("#rrggbb") at alpha 255; everything else is transparent. */
export function paintOverlay(index: Int32Array, labels: Uint8Array, colours: string[], rgba: Uint8ClampedArray): void {
  const rgb = colours.map((c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)));
  for (let p = 0; p < index.length; p++) {
    const k = index[p]!;
    const v = k >= 0 ? labels[k]! : 0;
    const o = 4 * p;
    const col = v > 0 ? rgb[v - 1] : undefined;
    if (!col) { rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 0; continue; }
    rgba[o] = col[0]!; rgba[o + 1] = col[1]!; rgba[o + 2] = col[2]!; rgba[o + 3] = 255;
  }
}
