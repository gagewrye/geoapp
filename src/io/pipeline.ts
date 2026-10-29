import { crossesAntimeridian, projString } from "../core/crs";
import { decimatedAffine, decimatedTile, decimateInto, decimationFactor } from "../core/decimate";
import { tileWindows } from "../core/grid";
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
  const { width, height, bandCount, gt, epsg, nodata } = source.meta;
  const f = decimationFactor(width, height, maxSide);
  const dec = decimatedTile(width, height, f, bandCount >= 3 ? 3 : 1, nodata);
  for (const w of tileWindows(width, height)) decimateInto(dec, await source.readWindow(w.x0, w.y0, w.width, w.height), f, width, height);
  return warpPreview(dec, decimatedAffine(gt, f), epsg, maxSide, stretch);
}
