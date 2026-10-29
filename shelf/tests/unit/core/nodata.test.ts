// Fragment of tests/unit/core/nodata.test.ts (spec 013): its isNodata assertion, to merge back by hand.
import { describe, expect, it } from "vitest";
import { isNodata, maskBit, nodataMask } from "../../../src/core/nodata";
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
  it("agrees with isNodata over all bands", () => {
    const t = tile(-9);
    const m = nodataMask(t);
    for (let i = 0; i < 15; i++) expect(maskBit(m, i) === 1).toBe(isNodata(t, [1, 2, 3], i));
  });
});

