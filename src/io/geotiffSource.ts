import { fromBlob, type GeoTIFF } from "geotiff";
import type { Affine } from "../core/types";
import type { GeoTags, RasterSource } from "./source";

const stripNul = (s: unknown) => (typeof s === "string" ? s.replace(/\0+$/, "") : undefined);
const nums = (v: unknown) => (v ? Array.from(v as ArrayLike<number>) : undefined);

/** Wrap the first image of a GeoTIFF/COG; reads only the header until a window is requested. */
export async function openGeoTiff(tiff: GeoTIFF): Promise<RasterSource> {
  const image = await tiff.getImage(0);
  const fd = image.fileDirectory;
  const keys = image.getGeoKeys() ?? {};
  const epsg = Number(keys.GTModelTypeGeoKey === 2 ? keys.GeographicTypeGeoKey : keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey) || 0;
  const geoTags: GeoTags = {
    GeoKeyDirectory: nums(fd.getValue("GeoKeyDirectory")) ?? [],
    ModelPixelScale: nums(fd.getValue("ModelPixelScale")),
    ModelTiepoint: nums(fd.getValue("ModelTiepoint")),
    ModelTransformation: nums(fd.getValue("ModelTransformation")),
    GeoDoubleParams: nums(fd.hasTag("GeoDoubleParams") ? await fd.loadValue("GeoDoubleParams") : undefined),
    GeoAsciiParams: stripNul(fd.getValue("GeoAsciiParams")),
  };
  for (const k of Object.keys(geoTags) as (keyof GeoTags)[]) if (geoTags[k] === undefined) delete geoTags[k];
  const gt = affineOf(geoTags, image.getOrigin(), image.getResolution());
  if (keys.GTRasterTypeGeoKey === 2) {
    // PixelIsPoint: tie point is a pixel centre, shift to the corner as GDAL does
    gt[0] -= 0.5 * (gt[1] + gt[2]);
    gt[3] -= 0.5 * (gt[4] + gt[5]);
  }
  const width = image.getWidth();
  const height = image.getHeight();
  const bandCount = image.getSamplesPerPixel();
  const nodata = image.getGDALNoData();
  return {
    meta: { width, height, bandCount, gt, epsg, nodata, geoTags },
    async readWindow(x0, y0, w, h) {
      const rasters = (await image.readRasters({ window: [x0, y0, x0 + w, y0 + h] })) as unknown as ArrayLike<number>[];
      const bands = Array.from(rasters, (r) => (r instanceof Float32Array ? r : Float32Array.from(r)));
      return { x0, y0, width: w, height: h, bands, nodata };
    },
  };
}

function affineOf(tags: GeoTags, origin: number[], res: number[]): Affine {
  const m = tags.ModelTransformation;
  if (m && m.length >= 8) return [m[3]!, m[0]!, m[1]!, m[7]!, m[4]!, m[5]!];
  return [origin[0]!, res[0]!, 0, origin[1]!, 0, res[1]!];
}

export async function openFile(file: Blob): Promise<RasterSource> {
  return openGeoTiff(await fromBlob(file));
}
