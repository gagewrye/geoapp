import { CONFLICT, NONE, isNodata, labelMap } from "./rasterize";
import type { PixelPolygon, Tile } from "./types";

/** Labelled samples from one tile; X is row-major [n][bands.length]. */
export function samplePixels(tile: Tile, polygons: PixelPolygon[], bands: number[]): { X: Float32Array; y: Uint8Array } {
  const labels = labelMap(tile, polygons);
  const idx: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (l !== NONE && l !== CONFLICT && !isNodata(tile, bands, i)) idx.push(i);
  }
  const nb = bands.length;
  const X = new Float32Array(idx.length * nb);
  const y = new Uint8Array(idx.length);
  idx.forEach((i, n) => {
    for (let j = 0; j < nb; j++) X[n * nb + j] = tile.bands[bands[j]! - 1]![i]!;
    y[n] = labels[i]!;
  });
  return { X, y };
}
