import { GeoTIFF, type GeoTIFFImage } from "geotiff";
import { alphaOf } from "../core/alpha";
import { affineFromTags } from "../core/geotags";
import { MAX_BLOCK_BYTES, type Block, type Overview } from "../core/imagery";
import { blobSource } from "./blobSource";
import type { GeoTags, ImagerySource, RasterMeta } from "./source";

const stripNul = (s: unknown) => (typeof s === "string" ? s.replace(/\0+$/, "") : undefined);
const list = (v: unknown): number[] => (v === undefined ? [] : typeof v === "number" ? [v] : Array.from(v as ArrayLike<number>));
const nums = (v: unknown) => (v ? Array.from(v as ArrayLike<number>) : undefined);

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
export async function openGeoTiff(tiff: GeoTIFF): Promise<ImagerySource> {
  const image = await tiff.getImage(0);
  const fd = image.fileDirectory;
  const { width, height, gt, epsg, geoTags } = await readGeoMeta(image);
  const bandCount = image.getSamplesPerPixel();
  // Bands are read as Float32Array, so compare against nodata rounded the same way.
  const nd = gdalNoData(image.getGDALNoData(), stripNul(fd.getValue("GDAL_NODATA")));
  const nodata = nd === null ? null : Math.fround(nd);
  const float = list(fd.getValue("SampleFormat")).includes(3);
  const alpha = alphaOf(list(fd.getValue("ExtraSamples")), bandCount); // overviews share it
  const images = new Map<number, GeoTIFFImage>([[0, image]]);
  const overviews: Overview[] = [];
  for (let i = 1, n = await tiff.getImageCount(); i < n; i++) {
    const im = await tiff.getImage(i);
    const t = Number(im.fileDirectory.getValue("NewSubfileType") ?? 0);
    // geotiff's own overview rule (geotiff.js:328-333), minus masks; other bands can't stand in for the image
    if (!(t & 1) || t & 4 || im.getSamplesPerPixel() !== bandCount) continue;
    // a block over the limit would be decoded whole by every read at its level, so that level decimates or shows the preview
    const block = blockOf(im);
    if (block.bytes > MAX_BLOCK_BYTES) continue;
    images.set(i, im);
    overviews.push({ index: i, width: im.getWidth(), height: im.getHeight(), block });
  }
  await Promise.all([...images.values()].map(loadBlockOffsets));
  return {
    meta: { width, height, bandCount, gt, epsg, nodata, float, alpha, geoTags },
    block: blockOf(image),
    overviews,
    async readSamples(index, x0, y0, w, h, samples, signal) {
      signal?.throwIfAborted();
      const im = images.get(index);
      if (!im) throw new Error(`No overview ${index}`);
      const rasters = await im.readRasters({ window: [x0, y0, x0 + w, y0 + h], samples, signal });
      signal?.throwIfAborted();
      return Array.from(rasters as unknown as ArrayLike<number>[]);
    },
    async readWindow(x0, y0, w, h) {
      const rasters = (await image.readRasters({ window: [x0, y0, x0 + w, y0 + h] })) as unknown as ArrayLike<number>[];
      const bands = Array.from(rasters, (r) => (r instanceof Float32Array ? r : Float32Array.from(r)));
      return { x0, y0, width: w, height: h, bands, nodata, alpha };
    },
  };
}

/** Loads an image's block offsets and sizes whole now, so reads don't fetch them one index at a time (spec 025). */
export async function loadBlockOffsets(im: GeoTIFFImage): Promise<void> {
  const fd = im.fileDirectory;
  await Promise.all((im.isTiled ? (["TileOffsets", "TileByteCounts"] as const) : (["StripOffsets", "StripByteCounts"] as const)).map((t) => fd.loadValue(t)));
}

/** An image's tile or strip, with all its samples decoded (spec 020 Block): a separate-planes file decodes one block per band. */
function blockOf(im: GeoTIFFImage): Block {
  const width = im.getTileWidth(), height = im.getTileHeight();
  return { width, height, bytes: width * height * im.getBytesPerPixel() };
}

/** geotiff.js parses GDAL's "-inf"/"inf" as NaN, so read infinities from the raw tag. */
function gdalNoData(parsed: number | null, raw: string | undefined): number | null {
  if (parsed === null || !Number.isNaN(parsed) || raw === undefined) return parsed;
  const t = raw.trim();
  return /^-inf/i.test(t) ? -Infinity : /^\+?inf/i.test(t) ? Infinity : parsed;
}

/** Opens a GeoTIFF through blobSource, so nearby block reads made together are one file read (spec 025). */
export async function openFile(file: Blob): Promise<ImagerySource> {
  return openGeoTiff(await GeoTIFF.fromSource(sourceOf(file)));
}

/** blobSource typed as geotiff's source: geotiff only calls fetch, reads fileSize and calls close if it has one. */
export const sourceOf = (file: Blob) => blobSource(file) as unknown as Parameters<typeof GeoTIFF.fromSource>[0];
