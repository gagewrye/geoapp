import { GeoTIFF } from "geotiff";
import { CLASS_ITEM } from "../core/classTable";
import type { Window } from "../core/grid";
import { MAX_READ_BYTES, rowReads, type Block } from "../core/imagery";
import { TILE_SIZE } from "../core/types";
import { blockOf, loadBlockOffsets, readGeoMeta, sourceOf } from "./geotiffSource";
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

/** A label file's window reads served from its 256-row bands (specs 023 F4, 024), the last LABEL_ROWS kept. */
// A band (or a CHUNK_WIDTH piece of a wider one) is read through spec 020's rowReads, so each read decodes at most
// MAX_READ_BYTES of blocks; windows visited row by row then decode each strip of an equal grid once.
export function rowBandReader(meta: { width: number; height: number }, block: Block, readRaw: (w: Window) => Promise<Uint8Array>) {
  const rows = new Map<string, Window & { data: Uint8Array }>(); // least recent first
  const readChunk = async (chunk: Window): Promise<Uint8Array> => {
    const data = new Uint8Array(chunk.width * chunk.height);
    for (const r of rowReads([chunk], 1, block, meta.width, meta.height)) {
      const part = await readRaw(r);
      for (let y = 0; y < r.height; y++) data.set(part.subarray(y * r.width, (y + 1) * r.width), (r.y0 - chunk.y0 + y) * chunk.width + (r.x0 - chunk.x0));
    }
    return data;
  };
  return async (w: Window): Promise<Uint8Array> => {
    const y0 = Math.floor(w.y0 / TILE_SIZE) * TILE_SIZE, x0 = Math.floor(w.x0 / CHUNK_WIDTH) * CHUNK_WIDTH;
    const chunk = { x0, y0, width: Math.min(CHUNK_WIDTH, meta.width - x0), height: Math.min(TILE_SIZE, meta.height - y0) };
    if (w.x0 + w.width > chunk.x0 + chunk.width || w.y0 + w.height > chunk.y0 + chunk.height) return readChunk(w); // not inside one chunk
    const key = `${x0},${y0}`;
    let c = rows.get(key);
    if (c) rows.delete(key);
    else c = { ...chunk, data: await readChunk(chunk) };
    rows.set(key, c);
    for (const k of rows.keys()) { if (rows.size <= LABEL_ROWS) break; rows.delete(k); }
    const out = new Uint8Array(w.width * w.height);
    for (let r = 0; r < w.height; r++) {
      const s = (w.y0 - c.y0 + r) * c.width + (w.x0 - c.x0);
      out.set(c.data.subarray(s, s + w.width), r * w.width);
    }
    return out;
  };
}

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
  await loadBlockOffsets(image);
  const item = (await image.getGDALMetadata())?.[CLASS_ITEM];
  // blobSource rejects with Blob.arrayBuffer's own DOMException (NotReadableError, NotFoundError), which maskReadFailed reads
  const readRaw = async (w: Window): Promise<Uint8Array> => {
    const [band] = (await image.readRasters({ window: [w.x0, w.y0, w.x0 + w.width, w.y0 + w.height], samples: [0] })) as unknown as Uint8Array[];
    return band!;
  };
  return { meta, classItem: typeof item === "string" ? item : null, read: rowBandReader(meta, blockOf(image), readRaw) };
}

/** The mask file can't be read any more: it changed on disk (NotReadableError) or is gone (NotFoundError), per the W3C File API. */
export const maskReadFailed = (e: unknown): boolean => e instanceof Error && (e.name === "NotReadableError" || e.name === "NotFoundError");

export async function openLabelFile(file: Blob): Promise<LabelSource> {
  return openLabelTiff(await GeoTIFF.fromSource(sourceOf(file)));
}
