import type { Range } from "./ranges";

/** The typed arrays geotiff.js returns for whole-byte samples, which raw reads return too. */
export type SampleArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** An uncompressed, pixel-interleaved image's storage (ADR 0024): strips are blocks as wide as the image. */
export type RawLayout = {
  width: number; height: number;
  blockWidth: number; blockHeight: number;
  bytesPerPixel: number;
  /** Byte offset and byte count of each block, row-major. */
  offsets: ArrayLike<number>; counts: ArrayLike<number>;
};

/** The bytes of one image row's pixels [x0, x0 + width) inside one block; length 0 for a block stored with no bytes. */
export type RowRange = Range & { row: number; x0: number; width: number };

/** Each row's byte range per block for the window's columns, clipped to the image, rows in order and blocks left to right. */
export function rowRanges(layout: RawLayout, x0: number, y0: number, w: number, h: number): RowRange[] {
  const { width, height, blockWidth: bw, blockHeight: bh, bytesPerPixel: bpp, offsets, counts } = layout;
  const across = Math.ceil(width / bw);
  const xa = Math.max(0, x0), xb = Math.min(width, x0 + w), ya = Math.max(0, y0), yb = Math.min(height, y0 + h);
  const out: RowRange[] = [];
  for (let y = ya; y < yb; y++) {
    const by = Math.floor(y / bh), r = y - by * bh;
    for (let bx = Math.floor(xa / bw); bx * bw < xb; bx++) {
      const i = by * across + bx, c0 = Math.max(xa, bx * bw), c1 = Math.min(xb, (bx + 1) * bw);
      const count = counts[i]!;
      if (count === 0) { out.push({ offset: 0, length: 0, row: y, x0: c0, width: c1 - c0 }); continue; }
      const start = (r * bw + c0 - bx * bw) * bpp, length = (c1 - c0) * bpp;
      // geotiff.js would fail reading past a short block too
      if (start + length > count) throw new RangeError(`Block ${i} is ${count} bytes, shorter than its layout`);
      out.push({ offset: offsets[i]! + start, length, row: y, x0: c0, width: c1 - c0 });
    }
  }
  return out;
}

type SampleCtor = new (buffer: ArrayBufferLike) => SampleArray;

/**
 * Copies samples `samples` of a range's pixels (spp per pixel) from its bytes into the window [x0, y0, w] of `out`,
 * one array per sample; an empty buffer writes `fill`. Bytes are read in the host's order (little-endian everywhere).
 */
export function copySamples(buf: ArrayBufferLike, piece: RowRange, spp: number, samples: number[], out: SampleArray[], x0: number, y0: number, w: number, fill: number): void {
  const at = (piece.row - y0) * w + piece.x0 - x0, n = piece.width;
  if (buf.byteLength === 0) {
    for (const dst of out) dst.fill(fill, at, at + n);
    return;
  }
  const src = new (out[0]!.constructor as SampleCtor)(buf);
  for (let k = 0; k < samples.length; k++) {
    const dst = out[k]!;
    for (let p = 0, q = samples[k]!; p < n; p++, q += spp) dst[at + p] = src[q]!;
  }
}
