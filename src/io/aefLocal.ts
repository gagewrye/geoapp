import type { Aoi } from "../core/aef";
import { fileRows, flipRows } from "../core/flip";
import { northUpAffine } from "../core/geotags";
import { utmGeoTags } from "./aefCache";
import { openFile } from "./geotiffSource";
import { openRaster } from "./pipeline";
import type { RasterSource } from "./source";

/** A file given to "Open AlphaEarth file" that is not AlphaEarth-encoded. */
export class AefFileError extends Error {
  constructor() {
    super("This isn't an AlphaEarth file (64 Int8 bands with nodata -128).");
  }
}

/**
 * Open a local AlphaEarth COG (spec 002): no request, no MAX_AOI_SIDE limit. Its north-up grid is
 * the Aoi, so a bottom-up file's rows are flipped on read.
 */
export async function openAefFile(file: Blob): Promise<{ source: RasterSource; aoi: Aoi }> {
  const s = await openFile(file);
  if (!s.aef) throw new AefFileError();
  await openRaster(s); // the same CRS and 180° checks as any local raster
  const { width, height, gt, epsg } = s.meta;
  const aoi: Aoi = { epsg, gt: northUpAffine(gt, height), width, height };
  const bottomUp = gt[5] > 0;
  return {
    aoi,
    source: {
      meta: { ...s.meta, gt: aoi.gt, geoTags: utmGeoTags(aoi) },
      async readWindow(x0, y0, w, h) {
        if (!bottomUp) return s.readWindow(x0, y0, w, h);
        const t = await s.readWindow(x0, fileRows(height, y0, h)[0], w, h);
        return { ...t, y0, bands: t.bands.map((b) => flipRows(b, w, h)) };
      },
    },
  };
}
