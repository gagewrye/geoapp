import type { Window } from "./grid";
import type { Tile } from "./types";

/** 1 bit per pixel, row-major (pixel i = byte i >> 3, bit i & 7); 1 where any band is nodata or NaN, or alpha is 0. */
export function nodataMask(tile: Tile): Uint8Array {
  const n = tile.width * tile.height;
  const out = new Uint8Array(Math.ceil(n / 8));
  const { nodata } = tile;
  for (const band of tile.bands) {
    for (let i = 0; i < n; i++) {
      const v = band[i]!;
      if (v === nodata || Number.isNaN(v)) out[i >> 3]! |= 1 << (i & 7);
    }
  }
  const a = tile.alpha == null ? undefined : tile.bands[tile.alpha];
  if (a) for (let i = 0; i < n; i++) if (a[i] === 0) out[i >> 3]! |= 1 << (i & 7); // spec 022 rule A
  return out;
}

/** The mask bit of pixel i: 1 = imagery nodata. */
export const maskBit = (mask: Uint8Array, i: number): number => (mask[i >> 3]! >> (i & 7)) & 1;

/** A read's pixels (any sample type), bands in the order alpha indexes. */
type Read = Window & { bands: ArrayLike<number>[] };

/** Sets window w's nodataMask bits (row-major in w) for the pixels of read r inside w, by nodataMask's rules (spec 023 F2). */
// Lets a mask be built read by read, at the file's sample type, without a Float32 copy of the window.
export function markNodata(bits: Uint8Array, w: Window, r: Read, nodata: number | null, alpha: number | null): void {
  const x0 = Math.max(w.x0, r.x0), x1 = Math.min(w.x0 + w.width, r.x0 + r.width);
  const y0 = Math.max(w.y0, r.y0), y1 = Math.min(w.y0 + w.height, r.y0 + r.height);
  if (x1 <= x0 || y1 <= y0) return;
  r.bands.forEach((band, k) => {
    const isAlpha = k === alpha;
    for (let y = y0; y < y1; y++) {
      const src = (y - r.y0) * r.width - r.x0, dst = (y - w.y0) * w.width - w.x0;
      for (let x = x0; x < x1; x++) {
        const v = band[src + x]!;
        if (v === nodata || Number.isNaN(v) || (isAlpha && v === 0)) { const i = dst + x; bits[i >> 3]! |= 1 << (i & 7); }
      }
    }
  });
}
