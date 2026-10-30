import { describe, expect, it } from "vitest";
import { markNodata, maskBit, nodataMask } from "../../../src/core/nodata";
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

describe("markNodata (spec 023 F2, review)", () => {
  /** A 7x5 window at (300, 40) of 3 bands, alpha band 2: nodata -9, NaN or alpha 0 by position. */
  const f = (k: number, c: number, r: number) => (k === 0 && (c + r) % 5 === 0 ? -9 : k === 1 && (c * r) % 7 === 3 ? NaN : k === 2 ? ((c + 2 * r) % 3 === 0 ? 0 : 255) : 1);
  const win = (x0: number, y0: number, width: number, height: number) => ({
    x0, y0, width, height,
    bands: [0, 1, 2].map((k) => Float64Array.from({ length: width * height }, (_, p) => f(k, x0 + (p % width), y0 + Math.floor(p / width)))),
  });
  const w = { x0: 300, y0: 40, width: 7, height: 5 };

  for (const [nodata, alpha] of [[-9, 2], [null, 2], [-9, null]] as const) {
    it(`reads covering the window in pieces, some past its edges, give nodataMask's bits (nodata ${nodata}, alpha ${alpha})`, () => {
      const bits = new Uint8Array(Math.ceil((w.width * w.height) / 8));
      for (const r of [win(290, 38, 30, 2), win(298, 40, 5, 4), win(303, 40, 10, 4), win(280, 44, 40, 3)]) markNodata(bits, w, r, nodata, alpha);
      const t = win(w.x0, w.y0, w.width, w.height);
      const want = nodataMask({ ...w, nodata, alpha, bands: t.bands.map((b) => Float32Array.from(b)) });
      expect(Array.from(bits)).toEqual(Array.from(want));
    });
  }

  it("a read that misses the window sets nothing", () => {
    const bits = new Uint8Array(5);
    markNodata(bits, w, win(0, 0, 50, 50), -9, 2);
    markNodata(bits, w, win(307, 40, 5, 5), -9, 2);
    expect(Array.from(bits)).toEqual([0, 0, 0, 0, 0]);
  });
});
