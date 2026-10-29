import type { Tile } from "./types";

/** 1 bit per pixel, row-major (pixel i = byte i >> 3, bit i & 7); 1 where any band is nodata or NaN. */
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
  return out;
}

/** The mask bit of pixel i: 1 = imagery nodata. */
export const maskBit = (mask: Uint8Array, i: number): number => (mask[i >> 3]! >> (i & 7)) & 1;
