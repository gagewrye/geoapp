import type { Affine, Tile } from "./types";

/** Smallest integer step so the decimated raster fits in maxSide. */
export function decimationFactor(width: number, height: number, maxSide: number): number {
  return Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
}

/** Empty decimated tile for a width x height raster; NaN means not yet filled; alpha indexes its bands (spec 022). */
export function decimatedTile(width: number, height: number, f: number, nb: number, nodata: number | null, alpha: number | null = null): Tile {
  const w = Math.ceil(width / f);
  const h = Math.ceil(height / f);
  return { x0: 0, y0: 0, width: w, height: h, nodata, alpha, bands: Array.from({ length: nb }, () => new Float32Array(w * h).fill(NaN)) };
}

// Output pixel i samples source pixel i*f + floor(f/2), clamped to the raster.
const srcIndex = (i: number, f: number, size: number) => Math.min(i * f + Math.floor(f / 2), size - 1);

/** A window of source pixels, bands as Float32 tiles or raw typed arrays. */
export type SourceWindow = Omit<Tile, "bands" | "nodata"> & { bands: ArrayLike<number>[] };

/** Copy the decimated samples that fall inside one source window into out, whose x0, y0 are in decimated pixels. */
export function decimateInto(out: Tile, win: SourceWindow, f: number, srcWidth: number, srcHeight: number): void {
  for (let j = 0; j < out.height; j++) {
    const r = srcIndex(out.y0 + j, f, srcHeight) - win.y0;
    if (r < 0 || r >= win.height) continue;
    for (let i = 0; i < out.width; i++) {
      const c = srcIndex(out.x0 + i, f, srcWidth) - win.x0;
      if (c < 0 || c >= win.width) continue;
      for (let k = 0; k < out.bands.length; k++) out.bands[k]![j * out.width + i] = win.bands[k]![r * win.width + c]!;
    }
  }
}

/** Geotransform of the decimated grid. */
export function decimatedAffine(gt: Affine, f: number): Affine {
  return [gt[0], gt[1] * f, gt[2] * f, gt[3], gt[4] * f, gt[5] * f];
}
