// Fragment of src/core/geotags.ts (spec 013): merge back by hand; the AlphaEarth mosaic and file open use it.
import type { Affine } from "./types";

/** North-up equivalent of an unrotated geotransform: a bottom-up origin moves to the northern edge. */
export function northUpAffine(gt: Affine, height: number): Affine {
  if (gt[5] <= 0) return [...gt];
  return [gt[0], gt[1], gt[2], gt[3] + gt[5] * height, gt[4], -gt[5]];
}
