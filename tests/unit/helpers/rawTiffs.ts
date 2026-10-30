import { deflateSync } from "node:zlib";
import type { Value } from "./sources";

/** One IFD of a general TIFF fixture (spec 028): any sample type, byte order, blocking, planar config and compression. */
export type RawImage = {
  width: number; height: number; bands: number; value: Value;
  bits: number; format?: 1 | 2 | 3;
  /** Tiles of w x h, or strips of `rows` rows. */
  layout: { tile: [number, number] } | { rows: number };
  planar?: 1 | 2;
  /** 1 none, 5 LZW, 8 Deflate. */
  compression?: 1 | 5 | 8;
  predictor?: 1 | 2;
  subfile?: number;
};

const SHORT = 3, LONG = 4, DOUBLE = 12;
const SIZE: Record<number, number> = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };
type Entry = { tag: number; type: number; values: number[] };

/** A GeoTIFF (EPSG:32633) holding the images, written little- or big-endian; image 0 is georeferenced. */
export function rawTiff(images: RawImage[], littleEndian = true): ArrayBuffer {
  const blocks = images.map((im) => blocksOf(im, littleEndian).map((b) => compress(b, im.compression ?? 1)));
  let at = 8;
  const offsets = blocks.map((bs) => bs.map((b) => { const o = at; at += b.length + (b.length & 1); return o; }));
  const ifds = images.map((im, i) => entries(im, offsets[i]!, blocks[i]!.map((b) => b.length), i === 0));
  const ifdAt: number[] = [];
  for (const e of ifds) {
    ifdAt.push(at);
    at += 2 + e.length * 12 + 4;
    for (const x of e) { const n = x.values.length * SIZE[x.type]!; if (n > 4) at += n + (n & 1); }
  }
  const buf = new ArrayBuffer(at), v = new DataView(buf), u8 = new Uint8Array(buf), le = littleEndian;
  v.setUint16(0, le ? 0x4949 : 0x4d4d); v.setUint16(2, 42, le); v.setUint32(4, ifdAt[0]!, le);
  blocks.forEach((bs, i) => bs.forEach((b, k) => u8.set(b, offsets[i]![k]!)));
  ifds.forEach((e, i) => {
    let p = ifdAt[i]!, data = p + 2 + e.length * 12 + 4;
    v.setUint16(p, e.length, le);
    for (const x of e) {
      const q = p + 2;
      v.setUint16(q, x.tag, le); v.setUint16(q + 2, x.type, le); v.setUint32(q + 4, x.values.length, le);
      const n = x.values.length * SIZE[x.type]!;
      let w = q + 8;
      if (n > 4) { v.setUint32(w, data, le); w = data; data += n + (n & 1); }
      x.values.forEach((val, j) => {
        const o = w + j * SIZE[x.type]!;
        if (x.type === SHORT) v.setUint16(o, val, le); else if (x.type === LONG) v.setUint32(o, val, le); else v.setFloat64(o, val, le);
      });
      p += 12;
    }
    v.setUint32(ifdAt[i]! + 2 + e.length * 12, ifdAt[i + 1] ?? 0, le);
  });
  return buf;
}

/** Writes one sample value of `bits` bits and `format` at byte o. */
function setSample(v: DataView, o: number, x: number, bits: number, format: number, le: boolean): void {
  if (format === 3) { if (bits === 32) v.setFloat32(o, x, le); else v.setFloat64(o, x, le); return; }
  const signed = format === 2;
  if (bits === 8) { if (signed) v.setInt8(o, x); else v.setUint8(o, x); }
  else if (bits === 16) { if (signed) v.setInt16(o, x, le); else v.setUint16(o, x, le); }
  else if (signed) v.setInt32(o, x, le); else v.setUint32(o, x, le);
}

/** Uncompressed blocks in file order: one per tile or strip, or per plane then block when planar is 2. */
function blocksOf(im: RawImage, le: boolean): Uint8Array[] {
  const tiled = "tile" in im.layout;
  const [bw, bh] = "tile" in im.layout ? im.layout.tile : [im.width, im.layout.rows];
  const planes = im.planar === 2 ? im.bands : 1, perPixel = planes === 1 ? im.bands : 1;
  const out: Uint8Array[] = [];
  for (let plane = 0; plane < planes; plane++) for (let y0 = 0; y0 < im.height; y0 += bh) for (let x0 = 0; x0 < im.width; x0 += bw) {
    const rows = tiled ? bh : Math.min(bh, im.height - y0);
    const rowBits = bw * perPixel * im.bits, rowBytes = Math.ceil(rowBits / 8);
    const b = new Uint8Array(rowBytes * rows), v = new DataView(b.buffer);
    for (let r = 0; r < rows; r++) for (let c = 0; c < bw; c++) for (let s = 0; s < perPixel; s++) {
      if (x0 + c >= im.width || y0 + r >= im.height) continue; // tile padding stays 0
      const x = im.value(planes === 1 ? s : plane, x0 + c, y0 + r);
      if (im.bits % 8 === 0) setSample(v, r * rowBytes + (c * perPixel + s) * (im.bits / 8), x, im.bits, im.format ?? 1, le);
      else putBits(b, r * rowBytes * 8 + (c * perPixel + s) * im.bits, im.bits, x);
    }
    out.push(b);
  }
  return out;
}

/** MSB-first bit packing (FillOrder 1), as geotiff.js reads samples that aren't whole bytes. */
function putBits(b: Uint8Array, at: number, bits: number, x: number): void {
  for (let i = 0; i < bits; i++) if ((x >> (bits - 1 - i)) & 1) b[(at + i) >> 3]! |= 0x80 >> ((at + i) & 7);
}

function compress(b: Uint8Array, compression: number): Uint8Array {
  if (compression === 8) return new Uint8Array(deflateSync(b));
  if (compression === 5) return lzwLiterals(b);
  return b;
}

/** A valid TIFF LZW stream of literal codes only: a Clear every 200 codes keeps the codes 9 bits wide. */
function lzwLiterals(b: Uint8Array): Uint8Array {
  const codes: number[] = [];
  b.forEach((x, i) => { if (i % 200 === 0) codes.push(256); codes.push(x); });
  codes.push(257);
  const out = new Uint8Array(Math.ceil((codes.length * 9) / 8));
  codes.forEach((c, i) => putBits(out, i * 9, 9, c));
  return out;
}

function entries(im: RawImage, offsets: number[], counts: number[], geo: boolean): Entry[] {
  const nb = im.bands, e: Entry[] = [];
  if (im.subfile) e.push({ tag: 254, type: LONG, values: [im.subfile] });
  e.push({ tag: 256, type: LONG, values: [im.width] }, { tag: 257, type: LONG, values: [im.height] },
    { tag: 258, type: SHORT, values: Array(nb).fill(im.bits) }, { tag: 259, type: SHORT, values: [im.compression ?? 1] },
    { tag: 262, type: SHORT, values: [1] });
  if ("tile" in im.layout) {
    e.push({ tag: 277, type: SHORT, values: [nb] }, { tag: 284, type: SHORT, values: [im.planar ?? 1] });
    if (im.predictor) e.push({ tag: 317, type: SHORT, values: [im.predictor] });
    e.push({ tag: 322, type: SHORT, values: [im.layout.tile[0]] }, { tag: 323, type: SHORT, values: [im.layout.tile[1]] },
      { tag: 324, type: LONG, values: offsets }, { tag: 325, type: LONG, values: counts });
  } else {
    e.push({ tag: 273, type: LONG, values: offsets }, { tag: 277, type: SHORT, values: [nb] },
      { tag: 278, type: LONG, values: [im.layout.rows] }, { tag: 279, type: LONG, values: counts }, { tag: 284, type: SHORT, values: [im.planar ?? 1] });
    if (im.predictor) e.push({ tag: 317, type: SHORT, values: [im.predictor] });
  }
  e.push({ tag: 339, type: SHORT, values: Array(nb).fill(im.format ?? 1) });
  if (geo) {
    e.push({ tag: 33550, type: DOUBLE, values: [10, 10, 0] }, { tag: 33922, type: DOUBLE, values: [0, 0, 0, 500000, 5000000, 0] },
      { tag: 34735, type: SHORT, values: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32633] });
  }
  return e;
}
