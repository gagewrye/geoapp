import type { Window } from "./grid";
import type { Grid } from "./types";
import { mercatorGrid } from "./warp";

/** Per overlay pixel, the index into w's tile, or -1; the same Mercator grid and corners as warpPreview. */
export function overlayIndex(w: Window, grid: Grid, maxSide: number) {
  const { width, height, corners, each } = mercatorGrid(w, grid.gt, grid.epsg, maxSide);
  const index = new Int32Array(width * height).fill(-1);
  each((o, c, r) => {
    const i = Math.floor(c - w.x0), j = Math.floor(r - w.y0);
    if (i >= 0 && i < w.width && j >= 0 && j < w.height) index[o] = j * w.width + i;
  });
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
