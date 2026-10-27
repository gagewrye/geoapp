import { tileWindows, type Window } from "../core/grid";
import { NODATA_OUT, TILE_SIZE } from "../core/types";
import type { GeoTags, Sink } from "./source";

// Classic TIFF: 4-byte offsets. BigTIFF would change only these two (ADR 0001).
const OFFSET_BYTES = 4;
export const MAX_TIFF_BYTES = 2 ** (8 * OFFSET_BYTES) - 1;
const TILE_BYTES = TILE_SIZE * TILE_SIZE;

const SHORT = 3, LONG = 4, ASCII = 2, DOUBLE = 12;
const TYPE_SIZE: Record<number, number> = { [SHORT]: 2, [LONG]: 4, [ASCII]: 1, [DOUBLE]: 8 };
type Entry = { tag: number; type: number; values: number[] | string };

/** GDAL_NODATA, which also fills tile padding, and an optional GDAL_METADATA (ADR 0013); both ASCII. */
export type TiffText = { nodata: string; metadata?: string };
/** Spec 001's classification: 255 is nodata. */
const CLASSIFIED: TiffText = { nodata: String(NODATA_OUT) };

function entries(width: number, height: number, tiles: number, first: number, geo: GeoTags, text: TiffText): Entry[] {
  const offsets = Array.from({ length: tiles }, (_, i) => first + i * TILE_BYTES);
  const e: Entry[] = [
    { tag: 256, type: LONG, values: [width] }, { tag: 257, type: LONG, values: [height] },
    { tag: 258, type: SHORT, values: [8] }, { tag: 259, type: SHORT, values: [1] },
    { tag: 262, type: SHORT, values: [1] }, { tag: 277, type: SHORT, values: [1] },
    { tag: 284, type: SHORT, values: [1] }, { tag: 322, type: SHORT, values: [TILE_SIZE] },
    { tag: 323, type: SHORT, values: [TILE_SIZE] }, { tag: 324, type: LONG, values: offsets },
    { tag: 325, type: LONG, values: offsets.map(() => TILE_BYTES) }, { tag: 339, type: SHORT, values: [1] },
  ];
  if (geo.ModelPixelScale) e.push({ tag: 33550, type: DOUBLE, values: geo.ModelPixelScale });
  if (geo.ModelTiepoint) e.push({ tag: 33922, type: DOUBLE, values: geo.ModelTiepoint });
  if (geo.ModelTransformation) e.push({ tag: 34264, type: DOUBLE, values: geo.ModelTransformation });
  e.push({ tag: 34735, type: SHORT, values: geo.GeoKeyDirectory });
  if (geo.GeoDoubleParams) e.push({ tag: 34736, type: DOUBLE, values: geo.GeoDoubleParams });
  if (geo.GeoAsciiParams !== undefined) e.push({ tag: 34737, type: ASCII, values: geo.GeoAsciiParams });
  if (text.metadata !== undefined) e.push({ tag: 42112, type: ASCII, values: text.metadata });
  e.push({ tag: 42113, type: ASCII, values: text.nodata });
  return e;
}

const count = (e: Entry) => (typeof e.values === "string" ? e.values.length + 1 : e.values.length);
const size = (e: Entry) => count(e) * TYPE_SIZE[e.type]!;
const even = (n: number) => n + (n & 1);

/** Header + IFD bytes and file size; throws before any write if over the classic limit or text isn't ASCII. */
export function tiffLayout(width: number, height: number, geo: GeoTags, text: TiffText = CLASSIFIED) {
  for (const t of [text.nodata, text.metadata ?? ""]) if ([...t].some((ch) => ch.charCodeAt(0) > 127)) throw new Error("TIFF ASCII tags must be 7-bit text");
  const tilesAcross = Math.ceil(width / TILE_SIZE);
  const tiles = tilesAcross * Math.ceil(height / TILE_SIZE);
  const probe = entries(width, height, tiles, 0, geo, text);
  const ifdBytes = 2 + probe.length * 12 + 4;
  const extra = probe.reduce((s, e) => s + (size(e) > 4 ? even(size(e)) : 0), 0);
  const headerBytes = 8 + ifdBytes + extra;
  const totalBytes = headerBytes + tiles * TILE_BYTES;
  if (totalBytes > MAX_TIFF_BYTES) throw new Error(`Output too large for classic TIFF (${width}x${height} needs ${totalBytes} bytes, limit ${MAX_TIFF_BYTES})`);
  return { header: encode(entries(width, height, tiles, headerBytes, geo, text), headerBytes), tiles, totalBytes };
}

function encode(list: Entry[], headerBytes: number): Uint8Array {
  const buf = new Uint8Array(headerBytes);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  v.setUint16(8, list.length, true);
  let data = 8 + 2 + list.length * 12 + 4;
  list.forEach((e, i) => {
    const p = 10 + i * 12;
    v.setUint16(p, e.tag, true); v.setUint16(p + 2, e.type, true); v.setUint32(p + 4, count(e), true);
    let at = p + 8;
    if (size(e) > 4) { v.setUint32(at, data, true); at = data; data += even(size(e)); }
    writeValues(v, at, e);
  });
  return buf;
}

function writeValues(v: DataView, at: number, e: Entry): void {
  if (typeof e.values === "string") {
    for (let i = 0; i < e.values.length; i++) v.setUint8(at + i, e.values.charCodeAt(i) & 0x7f);
    return;
  }
  const s = TYPE_SIZE[e.type]!;
  e.values.forEach((x, i) => {
    if (e.type === SHORT) v.setUint16(at + i * s, x, true);
    else if (e.type === LONG) v.setUint32(at + i * s, x, true);
    else v.setFloat64(at + i * s, x, true);
  });
}

/** Stream a single-band Uint8 tiled GeoTIFF: header+IFD first, then each 256x256 tile once, row-major. */
export async function writeTiff(sink: Sink, width: number, height: number, geo: GeoTags,
  tileAt: (win: Window) => Promise<Uint8Array>, text: TiffText = CLASSIFIED): Promise<void> {
  const { header } = tiffLayout(width, height, geo, text);
  await sink.write(header);
  for (const win of tileWindows(width, height)) {
    const px = await tileAt(win);
    const tile = new Uint8Array(TILE_BYTES).fill(Number(text.nodata));
    for (let r = 0; r < win.height; r++) tile.set(px.subarray(r * win.width, (r + 1) * win.width), r * TILE_SIZE);
    await sink.write(tile);
  }
  await sink.close();
}
