import { crossesAntimeridian, projString } from "../core/crs";
import { decimatedAffine, decimatedTile, decimateInto, decimationFactor } from "../core/decimate";
import { tileWindows } from "../core/grid";
import { blockWindows } from "../core/imagery";
import type { Affine, Tile } from "../core/types";
import { warpPreview } from "../core/warp";
import type { RasterSource } from "./source";

export class RasterRefusedError extends Error {
  constructor(readonly reason: "antimeridian" | "crs", message: string) {
    super(message);
  }
}

/** Refuse unsupported rasters from metadata alone, before any tile is read. */
export async function openRaster(source: Pick<RasterSource, "meta">): Promise<void> {
  const { epsg, gt, width, height } = source.meta;
  try {
    projString(epsg);
  } catch (e) {
    throw new RasterRefusedError("crs", (e as Error).message);
  }
  if (crossesAntimeridian(epsg, gt, width, height)) throw new RasterRefusedError("antimeridian", "Raster extent crosses 180 degrees");
}

/** Decimate window by window, then warp to a Mercator-aligned RGBA preview (stretch: see warpPreview). */
export async function buildPreview(source: RasterSource, maxSide: number, stretch?: [number, number]) {
  const { dec, gt } = await decimated(source, maxSide);
  return warpPreview(dec, gt, source.meta.epsg, maxSide, stretch);
}

/** The decimated raster the preview warps, and its geotransform. */
async function decimated(source: RasterSource, maxSide: number): Promise<{ dec: Tile; gt: Affine }> {
  const { width, height, bandCount, gt, nodata } = source.meta;
  const nb = bandCount >= 3 ? 3 : 1;
  const bands = nb === 3 ? [0, 1, 2] : [0];
  const { block, readSamples, overviews = [] } = source;
  // spec 020: the smallest overview with a longest side of at least maxSide stands in for the image
  const ov = overviews.filter((o) => Math.max(o.width, o.height) >= maxSide).sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (ov && readSamples) {
    const f = decimationFactor(ov.width, ov.height, maxSide);
    const dec = decimatedTile(ov.width, ov.height, f, nb, nodata);
    for (const w of tileWindows(ov.width, ov.height)) {
      decimateInto(dec, { ...w, bands: await readSamples.call(source, ov.index, w.x0, w.y0, w.width, w.height, bands) }, f, ov.width, ov.height);
    }
    const fx = width / ov.width, fy = height / ov.height;
    return { dec, gt: decimatedAffine([gt[0], gt[1] * fx, gt[2] * fy, gt[3], gt[4] * fx, gt[5] * fy], f) };
  }
  const f = decimationFactor(width, height, maxSide);
  const dec = decimatedTile(width, height, f, nb, nodata);
  if (block && readSamples) {
    // spec 020: only the blocks holding a sampled pixel, each decoded once, cropped to its sampled span
    for (const w of blockWindows(width, height, block.width, block.height, f)) {
      decimateInto(dec, { ...w, bands: await readSamples.call(source, 0, w.x0, w.y0, w.width, w.height, bands) }, f, width, height);
    }
  } else {
    for (const w of tileWindows(width, height)) decimateInto(dec, await source.readWindow(w.x0, w.y0, w.width, w.height), f, width, height);
  }
  return { dec, gt: decimatedAffine(gt, f) };
}
