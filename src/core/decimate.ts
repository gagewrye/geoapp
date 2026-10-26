import type { Affine, Tile } from "./types";

/** Smallest integer step so the decimated raster fits in maxSide. */
export function decimationFactor(width: number, height: number, maxSide: number): number {
  return Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
}

/** Empty decimated tile for a width x height raster; NaN means not yet filled. */
export function decimatedTile(width: number, height: number, f: number, nb: number, nodata: number | null): Tile {
  const w = Math.ceil(width / f);
  const h = Math.ceil(height / f);
  return { x0: 0, y0: 0, width: w, height: h, nodata, bands: Array.from({ length: nb }, () => new Float32Array(w * h).fill(NaN)) };
}

// Output pixel i samples source pixel i*f + floor(f/2), clamped to the raster.
const srcIndex = (i: number, f: number, size: number) => Math.min(i * f + Math.floor(f / 2), size - 1);

/** Copy the decimated samples that fall inside one source window into out. */
export function decimateInto(out: Tile, win: Tile, f: number, srcWidth: number, srcHeight: number): void {
  for (let j = 0; j < out.height; j++) {
    const r = srcIndex(j, f, srcHeight) - win.y0;
    if (r < 0 || r >= win.height) continue;
    for (let i = 0; i < out.width; i++) {
      const c = srcIndex(i, f, srcWidth) - win.x0;
      if (c < 0 || c >= win.width) continue;
      for (let k = 0; k < out.bands.length; k++) out.bands[k]![j * out.width + i] = win.bands[k]![r * win.width + c]!;
    }
  }
}

/** Geotransform of the decimated grid. */
export function decimatedAffine(gt: Affine, f: number): Affine {
  return [gt[0], gt[1] * f, gt[2] * f, gt[3], gt[4] * f, gt[5] * f];
}
