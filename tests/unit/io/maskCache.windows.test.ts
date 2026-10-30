import { describe, expect, it } from "vitest";
import { nodataMask } from "../../../src/core/nodata";
import type { Grid } from "../../../src/core/types";
import type { ValidMask } from "../../../src/core/validMask";
import { MaskCache, STROKE } from "../../../src/io/maskCache";
import { samplesSource } from "../helpers/sources";

// Spec 024 scope 3: an import asks for some windows of a band; a tiled file then reads only their tiles, and a
// striped one a single span from the first to the last (its strips are decoded once either way).

const W = 1800, H = 600;
const GRID: Grid = { width: W, height: H, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
const value = (k: number, c: number, r: number) => (k === 0 && (c * 3 + r) % 11 === 0 ? 0 : 5 + k);
const meta = { ...GRID, bandCount: 2, alpha: null, nodata: 0, float: false };
const bitsOf = (m: ValidMask, n: number) => (typeof m !== "string" ? m : new Uint8Array(Math.ceil(n / 8)).fill(m === "all" ? 0 : 255));

describe("need with windows (spec 024)", () => {
  it("on 256 px tiles, reads only the tiles of the windows asked for, and their masks are right", async () => {
    const { source, reads } = samplesSource(meta, value, { width: 256, height: 256, bytes: 256 * 256 * 2 }, true);
    const cache = new MaskCache(source);
    await cache.need(256, STROKE, [256, 1024, 1280]);
    expect(reads.map((r) => [r.x0, r.y0, r.width, r.height])).toEqual([[256, 256, 256, 256], [1024, 256, 512, 256]]);
    for (const x0 of [256, 1024, 1280]) {
      const want = nodataMask(await source.readWindow(x0, 256, 256, 256));
      expect(Buffer.from(bitsOf(cache.get(`${x0},256`)!, 65536)).equals(Buffer.from(want)), `${x0}`).toBe(true);
    }
    expect(cache.get("0,256")).toBeUndefined();
    expect(cache.get("512,256")).toBeUndefined();
    const n = reads.length;
    await cache.need(256, STROKE, [256, 1280]); // held: no read
    expect(reads).toHaveLength(n);
    await cache.need(256, STROKE); // the whole band: only the windows still missing
    expect(reads.slice(n).map((r) => [r.x0, r.width])).toEqual([[0, 256], [512, 512], [1536, 264]]);
  });

  it("on 1-row strips, reads one span from the first window asked for to the last, and keeps every window in it", async () => {
    const { source, reads } = samplesSource(meta, value, { width: W, height: 1, bytes: W * 2 });
    const cache = new MaskCache(source);
    await cache.need(0, STROKE, [256, 1280]);
    expect(new Set(reads.map((r) => `${r.x0},${r.width}`))).toEqual(new Set(["256,1280"]));
    const rows = reads.map((r) => r.y0).sort((a, b) => a - b);
    expect(rows).toEqual(Array.from({ length: 256 }, (_, i) => i).filter((y) => rows.includes(y)));
    expect(reads.reduce((a, r) => a + r.height, 0)).toBe(256); // each strip once
    for (const x0 of [256, 512, 768, 1024, 1280]) expect(cache.get(`${x0},0`), `${x0}`).toBeDefined();
    expect(cache.get("0,0")).toBeUndefined();
    expect(cache.finished).toBe(false);
  });
});
