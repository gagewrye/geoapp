import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_READ_BYTES, type Block } from "../../../src/core/imagery";
import { MaskCache, STROKE } from "../../../src/io/maskCache";
import type { ImagerySource, RasterMeta, RasterSource } from "../../../src/io/source";
import type { Tile } from "../../../src/core/types";

// Spec 023 "one mask read: 48 MiB" (ADR 0021), review finding 1: a band of a very wide file holds one read
// at the file's sample type plus 1 bit per pixel, not a Float32 copy of the whole band.

const MiB = 2 ** 20, W = 36_916, H = 256, BANDS = 4;
const META: RasterMeta = {
  width: W, height: H, bandCount: BANDS, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10], nodata: 0, float: false, alpha: null,
  geoTags: { GeoKeyDirectory: [1, 1, 0, 1, 3072, 0, 1, 32633], ModelPixelScale: [10, 10, 0], ModelTiepoint: [0, 0, 0, 500000, 5000000, 0] },
};
const value = (k: number, c: number, r: number) => ((c * 7 + r * 3 + k) % 251 === 0 ? 0 : 9);

/** Counts the bytes of every Float32Array made while the cache reads (the fake's own arrays are Uint8). */
function countFloat32() {
  const Orig = Float32Array;
  const seen = { bytes: 0 };
  vi.stubGlobal("Float32Array", class extends Orig {
    constructor(...a: ConstructorParameters<typeof Float32Array>) { super(...a); seen.bytes += this.byteLength; }
  });
  return seen;
}
afterEach(() => { vi.unstubAllGlobals(); });

const fill = (x0: number, y0: number, width: number, height: number, k: number) => {
  const a = new Uint8Array(width * height);
  for (let p = 0; p < a.length; p++) a[p] = value(k, x0 + (p % width), y0 + Math.floor(p / width));
  return a;
};

describe("one mask read stays within 48 MiB (36,916 x 256, 4 bands, nodata 0)", () => {
  it("through readSamples: no Float32 copy, and the largest read plus the bits is under 48 MiB", async () => {
    const block: Block = { width: W, height: 1, bytes: W * BANDS };
    let largest = 0;
    const source: ImagerySource = {
      meta: META, block, overviews: [],
      readWindow: () => { throw new Error("readWindow"); },
      async readSamples(_i, x0, y0, width, height, bands) {
        largest = Math.max(largest, width * height * bands.length);
        return bands.map((k) => fill(x0, y0, width, height, k));
      },
    };
    const f32 = countFloat32();
    const cache = new MaskCache(source);
    await cache.need(0, STROKE);
    expect(largest).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(f32.bytes).toBe(0);
    expect(largest + f32.bytes + W * 32).toBeLessThanOrEqual(48 * MiB);
    expect(typeof cache.get("0,0")).not.toBe("string");
  });

  it("through readWindow alone: each read decodes at most MAX_READ_BYTES of Float32", async () => {
    const reads: number[] = [];
    const source: RasterSource = {
      meta: META,
      async readWindow(x0, y0, width, height): Promise<Tile> {
        reads.push(width * height * BANDS * 4);
        return { x0, y0, width, height, nodata: 0, alpha: null, bands: [0, 1, 2, 3].map((k) => Float32Array.from(fill(x0, y0, width, height, k))) };
      },
    };
    const cache = new MaskCache(source);
    await cache.need(0, STROKE);
    expect(reads.length).toBeGreaterThan(1);
    expect(Math.max(...reads)).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(reads.reduce((a, b) => a + b)).toBe(W * H * BANDS * 4); // every pixel read once
  });
});
