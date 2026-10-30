import { fromBlob, type GeoTIFF } from "geotiff";
import { CLASS_ITEM } from "../core/classTable";
import type { Window } from "../core/grid";
import { MAX_READ_BYTES } from "../core/imagery";
import { TILE_SIZE } from "../core/types";
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

/** Row chunks of a label file kept (spec 023 F4), and their width: 256 rows of 1-byte samples within MAX_READ_BYTES. */
const LABEL_ROWS = 4, CHUNK_WIDTH = Math.floor(MAX_READ_BYTES / TILE_SIZE / TILE_SIZE) * TILE_SIZE;

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
  const meta: RasterMeta = { ...geo, bandCount: 1, nodata, float: false, alpha: null };
  await openRaster({ meta });
  const item = (await image.getGDALMetadata())?.[CLASS_ITEM];
  const rows = new Map<string, Window & { data: Uint8Array }>(); // the last LABEL_ROWS row chunks read, least recent first
  const readRaw = async (w: Window): Promise<Uint8Array> => {
    try {
      const [band] = (await image.readRasters({ window: [w.x0, w.y0, w.x0 + w.width, w.y0 + w.height], samples: [0] })) as unknown as Uint8Array[];
      return band!;
    } catch (e) {
      // geotiff.js's blob source rejects with the FileReader's error event; the File API's error is on its target
      const inner = (e as { target?: { error?: unknown } } | null)?.target?.error;
      throw inner instanceof Error ? inner : e;
    }
  };
  return {
    meta,
    classItem: typeof item === "string" ? item : null,
    // Spec 023 F4: a window is cut from its 256-row chunk (at most MAX_READ_BYTES of samples), and the last
    // LABEL_ROWS chunks are kept, so the windows of a striped file's row band decode its strips once.
    async read(w) {
      const y0 = Math.floor(w.y0 / TILE_SIZE) * TILE_SIZE, x0 = Math.floor(w.x0 / CHUNK_WIDTH) * CHUNK_WIDTH;
      const chunk = { x0, y0, width: Math.min(CHUNK_WIDTH, meta.width - x0), height: Math.min(TILE_SIZE, meta.height - y0) };
      if (w.x0 + w.width > chunk.x0 + chunk.width || w.y0 + w.height > chunk.y0 + chunk.height) return readRaw(w); // not inside one chunk
      const key = `${x0},${y0}`;
      let c = rows.get(key);
      if (c) rows.delete(key);
      else c = { ...chunk, data: await readRaw(chunk) };
      rows.set(key, c);
      for (const k of rows.keys()) { if (rows.size <= LABEL_ROWS) break; rows.delete(k); }
      const out = new Uint8Array(w.width * w.height);
      for (let r = 0; r < w.height; r++) {
        const s = (w.y0 - c.y0 + r) * c.width + (w.x0 - c.x0);
        out.set(c.data.subarray(s, s + w.width), r * w.width);
      }
      return out;
    },
  };
}

/** The mask file can't be read any more: it changed on disk (NotReadableError) or is gone (NotFoundError), per the W3C File API. */
export const maskReadFailed = (e: unknown): boolean => e instanceof Error && (e.name === "NotReadableError" || e.name === "NotFoundError");

export async function openLabelFile(file: Blob): Promise<LabelSource> {
  return openLabelTiff(await fromBlob(file));
}
