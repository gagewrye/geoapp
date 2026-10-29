// Fragment of src/core/nodata.ts (spec 013): merge back by hand; labelSamples and predict use it.
import type { Tile } from "./types";

/** True when any of `bands` (1-based) equals tile.nodata or is NaN at pixel i (spec 001's rule). */
export function isNodata(tile: Tile, bands: number[], i: number): boolean {
  for (const b of bands) {
    const v = tile.bands[b - 1]![i]!;
    if (Number.isNaN(v) || v === tile.nodata) return true;
  }
  return false;
}
