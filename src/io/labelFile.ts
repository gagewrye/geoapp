import { fromBlob, type GeoTIFF } from "geotiff";
import { CLASS_ITEM } from "../core/classTable";
import type { Window } from "../core/grid";
import { readGeoMeta } from "./geotiffSource";
import { openRaster } from "./pipeline";
import type { RasterMeta } from "./source";

/** A class raster to import (spec 004): single-band Uint8, read one window at a time. */
export type LabelSource = {
  /** bandCount 1; nodata is GDAL_NODATA when an integer 0..255, else null (every value is a class). */
  meta: RasterMeta;
  /** The raw inner text of the GDAL_METADATA CLASS_ITEM, if the file has one. */
  classItem: string | null;
  read(w: Window): Promise<Uint8Array>;
};

/** The file isn't a single-band 8-bit unsigned GeoTIFF. */
export class LabelFileRefused extends Error {
  constructor(why: string) { super(`Not a label file: ${why}`); }
}

const list = (v: unknown): number[] => (v === undefined ? [] : typeof v === "number" ? [v] : Array.from(v as ArrayLike<number>));

/** Opens a class raster: refuses other layouts, then applies spec 001's CRS and 180° checks; reads only the header. */
export async function openLabelTiff(tiff: GeoTIFF): Promise<LabelSource> {
  const image = await tiff.getImage(0);
  const fd = image.fileDirectory;
  const bands = image.getSamplesPerPixel();
  const bits = list(fd.getValue("BitsPerSample"));
  const format = list(fd.getValue("SampleFormat")); // missing means unsigned integer
  if (bands !== 1) throw new LabelFileRefused(`${bands} bands`);
  if (bits.length !== 1 || bits[0] !== 8 || !(format.length === 0 || format[0] === 1)) throw new LabelFileRefused(`${bits[0]}-bit, sample format ${format[0] ?? 1}`);
  const geo = await readGeoMeta(image);
  const nd = image.getGDALNoData();
  const nodata = nd !== null && Number.isInteger(nd) && nd >= 0 && nd <= 255 ? nd : null;
  const meta: RasterMeta = { ...geo, bandCount: 1, nodata };
  await openRaster({ meta });
  const item = (await image.getGDALMetadata())?.[CLASS_ITEM];
  return {
    meta,
    classItem: typeof item === "string" ? item : null,
    async read(w) {
      const [band] = (await image.readRasters({ window: [w.x0, w.y0, w.x0 + w.width, w.y0 + w.height], samples: [0] })) as unknown as Uint8Array[];
      return band!;
    },
  };
}

export async function openLabelFile(file: Blob): Promise<LabelSource> {
  return openLabelTiff(await fromBlob(file));
}
