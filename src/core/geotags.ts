import type { Affine } from "./types";

type GeoRef = { ModelTransformation?: number[]; ModelPixelScale?: number[]; ModelTiepoint?: number[] };

/**
 * GDAL geotransform from a GeoTIFF's own tags. geotiff.js getResolution negates the y scale
 * even for a ModelTransformation, which misplaces bottom-up files (spec 002), so it is not used.
 */
export function affineFromTags(tags: GeoRef, pixelIsPoint: boolean): Affine {
  const m = tags.ModelTransformation;
  const s = tags.ModelPixelScale;
  const t = tags.ModelTiepoint;
  let gt: Affine;
  if (m && m.length >= 8) gt = [m[3]!, m[0]!, m[1]!, m[7]!, m[4]!, m[5]!];
  else if (s && s.length >= 2 && t && t.length >= 6) gt = [t[3]! - t[0]! * s[0]!, s[0]!, 0, t[4]! + t[1]! * s[1]!, 0, -s[1]!];
  else throw new Error("GeoTIFF has no georeferencing (ModelTransformation or ModelPixelScale + ModelTiepoint)");
  if (pixelIsPoint) {
    // PixelIsPoint: the tie point is a pixel centre; shift to the corner as GDAL does
    gt[0] -= 0.5 * (gt[1] + gt[2]);
    gt[3] -= 0.5 * (gt[4] + gt[5]);
  }
  return gt;
}

/** North-up equivalent of an unrotated geotransform: a bottom-up origin moves to the northern edge. */
export function northUpAffine(gt: Affine, height: number): Affine {
  if (gt[5] <= 0) return [...gt];
  return [gt[0], gt[1], gt[2], gt[3] + gt[5] * height, gt[4], -gt[5]];
}
