import { describe, expect, it } from "vitest";
import { maskBit, nodataMask } from "../../../src/core/nodata";
import type { Tile } from "../../../src/core/types";

/** 5x3 tile: band 1 Float32 with NaN at pixel 7, band 2 with -9 at pixel 3, band 3 with -9 nowhere. */
function tile(nodata: number | null): Tile {
  const n = 15;
  const b1 = new Float32Array(n).fill(1), b2 = new Float32Array(n).fill(2), b3 = new Float32Array(n).fill(3);
  b1[7] = NaN;
  b2[3] = -9;
  b1[11] = -8; // not nodata
  return { x0: 256, y0: 0, width: 5, height: 3, bands: [b1, b2, b3], nodata };
}
const bits = (m: Uint8Array, n: number) => Array.from({ length: n }, (_, i) => maskBit(m, i));

describe("nodataMask (criterion 18)", () => {
  it("sets the bit of a pixel equal to nodata in band 2 only and of a NaN pixel in a Float32 band; a 5x3 tile gives 2 bytes", () => {
    const m = nodataMask(tile(-9));
    expect(m).toHaveLength(2);
    const want = Array.from({ length: 15 }, (_, i) => (i === 3 || i === 7 ? 1 : 0));
    expect(bits(m, 15)).toEqual(want);
    expect(m[0]).toBe((1 << 3) | (1 << 7));
    expect(m[1]).toBe(0); // padding bits stay 0
  });

  it("with nodata null only NaN is set", () => {
    const m = nodataMask(tile(null));
    expect(bits(m, 15)).toEqual(Array.from({ length: 15 }, (_, i) => (i === 7 ? 1 : 0)));
  });

  it("is ceil(width * height / 8) bytes", () => {
    for (const [w, h] of [[1, 1], [8, 1], [9, 1], [256, 256], [88, 44]] as const) {
      const t: Tile = { x0: 0, y0: 0, width: w, height: h, bands: [new Float32Array(w * h)], nodata: null };
      expect(nodataMask(t)).toHaveLength(Math.ceil((w * h) / 8));
    }
  });
});
