import { fromBlob, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import { AEF_BANDS, AEF_NODATA_Q, dequantize } from "../core/aef";
import { affineFromTags } from "../core/geotags";
import type { GeoTags, RasterMeta, RasterSource } from "./source";

const stripNul = (s: unknown) => (typeof s === "string" ? s.replace(/\0+$/, "") : undefined);
const nums = (v: unknown) => (v ? Array.from(v as ArrayLike<number>) : undefined);

/** A raster from a GeoTIFF; `aef` is true for an AlphaEarth-encoded file, read dequantized. */
export type GeoTiffSource = RasterSource & { aef: boolean };

/** Size, CRS, geotransform and copyable georeferencing tags of a GeoTIFF image; reads only the header. */
export async function readGeoMeta(image: GeoTIFFImage): Promise<Pick<RasterMeta, "width" | "height" | "gt" | "epsg" | "geoTags">> {
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
  const gt = affineFromTags(geoTags, keys.GTRasterTypeGeoKey === 2);
  return { width: image.getWidth(), height: image.getHeight(), gt, epsg, geoTags };
}

/** Wrap the first image of a GeoTIFF/COG; reads only the header until a window is requested. */
export async function openGeoTiff(tiff: GeoTIFF): Promise<GeoTiffSource> {
  const image = await tiff.getImage(0);
  const fd = image.fileDirectory;
  const { width, height, gt, epsg, geoTags } = await readGeoMeta(image);
  const bandCount = image.getSamplesPerPixel();
  // Bands are read as Float32Array, so compare against nodata rounded the same way.
  const nd = gdalNoData(image.getGDALNoData(), stripNul(fd.getValue("GDAL_NODATA")));
  // AlphaEarth COGs are read dequantized (spec 002); their no data becomes NaN.
  const aef = isAef(fd.getValue("SampleFormat"), fd.getValue("BitsPerSample"), bandCount, nd);
  const nodata = aef || nd === null ? null : Math.fround(nd);
  return {
    aef,
    meta: { width, height, bandCount, gt, epsg, nodata, geoTags },
    async readWindow(x0, y0, w, h) {
      const rasters = (await image.readRasters({ window: [x0, y0, x0 + w, y0 + h] })) as unknown as ArrayLike<number>[];
      const bands = Array.from(rasters, (r) => {
        if (!aef) return r instanceof Float32Array ? r : Float32Array.from(r);
        const out = new Float32Array(r.length);
        dequantize(r as Int8Array, out);
        return out;
      });
      return { x0, y0, width: w, height: h, bands, nodata };
    },
  };
}

/** 64 signed 8-bit bands with GDAL_NODATA -128: the AlphaEarth Int8 encoding. */
function isAef(format: unknown, bits: unknown, bandCount: number, nodata: number | null): boolean {
  // a missing SampleFormat means unsigned; a single value may come back as a number
  const all = (v: unknown, x: number) => v !== undefined && Array.from(typeof v === "number" ? [v] : (v as ArrayLike<number>)).every((e) => e === x);
  return bandCount === AEF_BANDS && nodata === AEF_NODATA_Q && all(format, 2) && all(bits, 8);
}

/** geotiff.js parses GDAL's "-inf"/"inf" as NaN, so read infinities from the raw tag. */
function gdalNoData(parsed: number | null, raw: string | undefined): number | null {
  if (parsed === null || !Number.isNaN(parsed) || raw === undefined) return parsed;
  const t = raw.trim();
  return /^-inf/i.test(t) ? -Infinity : /^\+?inf/i.test(t) ? Infinity : parsed;
}

export async function openFile(file: Blob): Promise<GeoTiffSource> {
  return openGeoTiff(await fromBlob(file));
}
