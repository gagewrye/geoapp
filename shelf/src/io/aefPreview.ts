import { AEF_PREVIEW_NODATA, aefPreview } from "../core/aef";
import { buildPreview } from "./pipeline";
import type { RasterSource } from "./source";

/** False-colour preview of AlphaEarth data (core aefPreview), built window by window. */
export function buildAefPreview(source: RasterSource, maxSide: number) {
  const rgb: RasterSource = {
    meta: { ...source.meta, bandCount: 3, nodata: AEF_PREVIEW_NODATA },
    readWindow: async (x0, y0, w, h) => aefPreview(await source.readWindow(x0, y0, w, h)),
  };
  // aefPreview has already stretched [-0.3, 0.3] to 0..255; a per-band stretch would undo that
  return buildPreview(rgb, maxSide, [0, 255]);
}
