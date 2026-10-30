import { describe, expect, it } from "vitest";
import { decodedBytes, MAX_READ_BYTES, type Block } from "../../../src/core/imagery";
import { nodataMask } from "../../../src/core/nodata";
import type { ValidMask } from "../../../src/core/validMask";
import { MaskCache, STROKE } from "../../../src/io/maskCache";
import type { RasterMeta } from "../../../src/io/source";
import { samplesSource, type SampleRead, type Value } from "../helpers/sources";

// Spec 023 criteria 3 and 4, tester edge cases: NaN pixels with no alpha, integer nodata with no alpha,
// a raster smaller than one window, partial edge windows and tiled (not striped) blocks.

const bitsOf = (m: ValidMask, n: number) => (typeof m !== "string" ? m : new Uint8Array(Math.ceil(n / 8)).fill(m === "all" ? 0 : 255));

/** Reads every band, then checks every window's mask against nodataMask of the same window; returns the reads. */
async function allMasks(meta: Partial<RasterMeta> & { width: number; height: number }, f: Value, block: Block) {
  const { source, reads } = samplesSource({ epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10], alpha: null, ...meta }, f, block, true);
  const cache = new MaskCache(source);
  const { width: W, height: H } = meta;
  for (let y0 = 0; y0 < H; y0 += 256) await cache.need(y0, STROKE);
  for (let y0 = 0; y0 < H; y0 += 256) for (let x0 = 0; x0 < W; x0 += 256) {
    const w = Math.min(256, W - x0), h = Math.min(256, H - y0);
    const m = cache.get(`${x0},${y0}`);
    expect(m, `${x0},${y0}`).toBeDefined();
    const want = nodataMask(await source.readWindow(x0, y0, w, h));
    expect(Buffer.from(bitsOf(m!, w * h)).equals(Buffer.from(want)), `${x0},${y0}`).toBe(true);
  }
  return { reads, cache };
}
const rowsOnce = (reads: SampleRead[], H: number) => {
  const rows = new Set<number>();
  for (const r of reads) for (let y = r.y0; y < r.y0 + r.height; y++) {
    expect(rows.has(y), `row ${y}`).toBe(false);
    expect(y).toBeLessThan(H);
    rows.add(y);
  }
  return rows;
};

describe("mask edge cases", () => {
  it("float samples, no nodata, no alpha: NaN pixels are nodata, every band is read once", async () => {
    const W = 700, H = 530, f: Value = (k, c, r) => (k === 1 && (c + r) % 97 === 0 ? NaN : c < 260 && r < 260 ? NaN : 10 + k);
    const { reads } = await allMasks({ width: W, height: H, bandCount: 2, nodata: null, float: true }, f, { width: W, height: 1, bytes: W * 8 });
    expect(reads.every((r) => r.bands.join() === "0,1")).toBe(true);
    expect(rowsOnce(reads, H).size).toBe(H);
  });

  it("integer nodata, no alpha: every band is read, and a nodata value in one band alone makes the pixel nodata", async () => {
    const W = 600, H = 300, f: Value = (k, c, r) => (k === 2 && c > 400 && r > 100 ? 0 : 5 + k);
    const { reads, cache } = await allMasks({ width: W, height: H, bandCount: 3, nodata: 0, float: false }, f, { width: W, height: 1, bytes: W * 3 });
    expect(reads.every((r) => r.bands.join() === "0,1,2")).toBe(true);
    expect(cache.get("0,0")).toBe("all");
  });

  it("a raster smaller than one window: one partial mask, no read past the raster", async () => {
    const W = 100, H = 70, f: Value = (k, c) => (k === 3 ? (c < 50 ? 0 : 255) : 1);
    const { reads, cache } = await allMasks({ width: W, height: H, bandCount: 4, alpha: 3, nodata: null, float: false }, f, { width: W, height: 1, bytes: W * 4 });
    expect(reads.every((r) => r.bands.join() === "3" && r.x0 === 0 && r.width === W)).toBe(true);
    expect(rowsOnce(reads, H).size).toBe(H);
    expect(typeof cache.get("0,0")).not.toBe("string");
  });

  it("256x256 tiles with partial edge tiles: reads within MAX_READ_BYTES, each row once, masks equal nodataMask", async () => {
    const W = 2100, H = 1000, block: Block = { width: 256, height: 256, bytes: 256 * 256 * 4 };
    const f: Value = (k, c, r) => (k === 3 ? (c >= 2000 || r >= 900 || (c >> 5) % 3 === 0 ? 0 : 255) : 50);
    const { reads, cache } = await allMasks({ width: W, height: H, bandCount: 4, alpha: 3, nodata: null, float: false }, f, block);
    for (const r of reads) expect(decodedBytes(r, block, W, H)).toBeLessThanOrEqual(MAX_READ_BYTES);
    // reads of 512 KiB split each band into columns (spec 028 TASK_READ_BYTES): every pixel once, rather than every row once
    expect(reads.reduce((n, r) => n + r.width * r.height, 0)).toBe(W * H);
    expect(cache.get("2048,768")).toBe("none"); // the bottom-right partial window: wholly transparent
  });

  it("all-transparent and all-opaque rasters hold no mask arrays", async () => {
    for (const a of [0, 255]) {
      const W = 520, H = 300;
      const { cache } = await allMasks({ width: W, height: H, bandCount: 4, alpha: 3, nodata: null, float: false }, (k) => (k === 3 ? a : 7), { width: W, height: 1, bytes: W * 4 });
      for (const key of ["0,0", "256,0", "512,0", "0,256", "512,256"]) expect(cache.get(key)).toBe(a ? "all" : "none");
    }
  });
});
