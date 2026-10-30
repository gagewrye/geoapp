import { describe, expect, it } from "vitest";
import { decodedBytes, MAX_READ_BYTES, TASK_READ_BYTES, type Block } from "../../../src/core/imagery";
import { MaskCache, STROKE } from "../../../src/io/maskCache";
import type { ImagerySource } from "../../../src/io/source";
import { samplesSource } from "../helpers/sources";

// Spec 028 criterion 3 (mask reads through geotiff decode at most TASK_READ_BYTES) and scope 3 (a yield between bands).

const W = 6000, H = 1024; // 4 bands of 256 rows; 1-row RGBA strips of 24,000 B
const strips: Block = { width: W, height: 1, bytes: W * 4 };
const value = (k: number, c: number, r: number) => (k === 3 ? ((c + r) % 97 === 0 ? 0 : 255) : 100);
const rgba = (raw?: number[]) => {
  const { source, reads } = samplesSource({ width: W, height: H, bandCount: 4, alpha: 3, nodata: null, float: false }, value, strips);
  return { source: { ...source, raw } as ImagerySource, reads };
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("mask read size (criterion 3)", () => {
  it("through geotiff: each read decodes at most TASK_READ_BYTES, and each row is read once", async () => {
    const { source, reads } = rgba();
    await new MaskCache(source).need(0, STROKE);
    expect(reads.length).toBeGreaterThan(1);
    for (const r of reads) expect(decodedBytes(r, strips, W, H)).toBeLessThanOrEqual(TASK_READ_BYTES);
    expect(reads.reduce((n, r) => n + r.height, 0)).toBe(256);
  });

  it("raw reads keep MAX_READ_BYTES: a band is one read", async () => {
    const { source, reads } = rgba([0]);
    await new MaskCache(source).need(0, STROKE);
    expect(reads.map((r) => r.height)).toEqual([256]);
    expect(decodedBytes(reads[0]!, strips, W, H)).toBeLessThanOrEqual(MAX_READ_BYTES);
  });
});

describe("yields between background bands (scope 3)", () => {
  it("reads the next band only after the yield resolves", async () => {
    const { source, reads } = rgba([0]);
    const yields: (() => void)[] = [];
    const cache = new MaskCache(source, { yieldTask: () => new Promise<void>((r) => yields.push(r)) });
    cache.start(0);
    await tick();
    expect(reads.map((r) => r.y0)).toEqual([0]);
    expect(yields).toHaveLength(1);
    yields.shift()!();
    await tick();
    expect(reads.map((r) => r.y0)).toEqual([0, 256]);
    while (!cache.finished) { yields.shift()?.(); await tick(); }
    expect(reads).toHaveLength(4);
  });
});
