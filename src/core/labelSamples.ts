import { isNodata } from "./nodata";
import type { Tile } from "./types";

/** Training samples from one tile and its labels; y = value - 1; skips 0, nodata and NaN. X is row-major [n][bands.length]. */
export function labelSamples(tile: Tile, labels: Uint8Array, bands: number[]): { X: Float32Array; y: Uint8Array } {
  if (labels.length !== tile.width * tile.height) throw new Error(`labelSamples: ${labels.length} labels for a ${tile.width}x${tile.height} tile`);
  const idx: number[] = [];
  for (let i = 0; i < labels.length; i++) if (labels[i] && !isNodata(tile, bands, i)) idx.push(i);
  const nb = bands.length;
  const X = new Float32Array(idx.length * nb);
  const y = new Uint8Array(idx.length);
  const src = bands.map((b) => tile.bands[b - 1]!);
  idx.forEach((i, n) => {
    for (let j = 0; j < nb; j++) X[n * nb + j] = src[j]![i]!;
    y[n] = labels[i]! - 1;
  });
  return { X, y };
}
