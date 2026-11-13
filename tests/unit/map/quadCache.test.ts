import { describe, expect, it, vi } from "vitest";
import * as quads from "../../../src/core/labelQuads";
import { keysAround } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { QuadCache } from "../../../src/map/quadCache";

vi.mock("../../../src/core/labelQuads", async (orig) => {
  const m = await orig<typeof import("../../../src/core/labelQuads")>();
  return { ...m, tileQuads: vi.fn(m.tileQuads) };
});

// Spec 023 criterion 8: after hovering in Paint and letting idle callbacks run, the 5x5 tiles around the footprint need no tileQuads.

const GRID: Grid = { width: 3000, height: 2000, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };

describe("keysAround", () => {
  it("gives the 5x5 tiles around the footprint's centre tile, clipped to the raster, row-major", () => {
    expect(keysAround(GRID, { x0: 600, y0: 600, width: 7, height: 7 })).toHaveLength(25);
    expect(keysAround(GRID, { x0: 600, y0: 600, width: 7, height: 7 })[0]).toBe("0,0");
    expect(keysAround(GRID, { x0: 0, y0: 0, width: 7, height: 7 })).toEqual(["0,0", "256,0", "512,0", "0,256", "256,256", "512,256", "0,512", "256,512", "512,512"]);
  });
});

describe("QuadCache (criterion 8)", () => {
  it("prefetched in idle callbacks, the 25 tiles around a hover call tileQuads 0 times when drawn, and keep their quads", () => {
    const idle: ((d: { timeRemaining(): number }) => void)[] = [];
    const cache = new QuadCache(GRID, (cb) => { idle.push(cb); });
    const keys = keysAround(GRID, { x0: 1200, y0: 900, width: 127, height: 127 });
    expect(keys).toHaveLength(25);
    cache.prefetch(keys);
    let budget = 3; // three tiles per idle callback here
    while (idle.length) { budget = 3; idle.shift()!({ timeRemaining: () => (budget-- > 0 ? 50 : 0) }); }
    const spy = vi.mocked(quads.tileQuads);
    spy.mockClear();
    for (const k of keys) expect(cache.get(k).length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(0);
    cache.get("0,0"); // not prefetched: computed once, then kept
    cache.get("0,0");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("prefetching none drops the tiles still queued", () => {
    const idle: ((d: { timeRemaining(): number; didTimeout?: boolean }) => void)[] = [];
    const cache = new QuadCache(GRID, (cb) => { idle.push(cb); });
    cache.prefetch(["0,0", "256,0", "512,0"]);
    idle.shift()!({ timeRemaining: () => 0, didTimeout: true }); // a timed-out callback still computes one tile
    cache.prefetch([]);
    while (idle.length) idle.shift()!({ timeRemaining: () => 50 });
    const spy = vi.mocked(quads.tileQuads);
    spy.mockClear();
    cache.get("0,0");
    cache.get("256,0");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("prefetching again schedules nothing for tiles already computed", () => {
    const idle: (() => void)[] = [];
    const cache = new QuadCache(GRID, (cb) => { idle.push(() => cb({ timeRemaining: () => 50 })); });
    cache.prefetch(["0,0", "256,0"]);
    idle.shift()!();
    cache.prefetch(["0,0", "256,0"]);
    expect(idle).toHaveLength(0);
  });

  it("starts no tile on a short idle period, reschedules, and computes one tile when the callback timed out (review 2)", () => {
    const idle: ((d: { timeRemaining(): number; didTimeout?: boolean }) => void)[] = [];
    const cache = new QuadCache(GRID, (cb) => { idle.push(cb); });
    const spy = vi.mocked(quads.tileQuads);
    cache.prefetch(["0,0", "256,0", "512,0"]);
    spy.mockClear();
    idle.shift()!({ timeRemaining: () => 39 });
    expect(spy).toHaveBeenCalledTimes(0);
    expect(idle).toHaveLength(1);
    idle.shift()!({ timeRemaining: () => 0, didTimeout: true });
    expect(spy).toHaveBeenCalledTimes(1);
    let t = 55;
    idle.shift()!({ timeRemaining: () => (t -= 10) }); // 45 ms: one tile; 35 left after it: stops there
    expect(spy).toHaveBeenCalledTimes(2);
    expect(idle).toHaveLength(1);
  });
});

describe("QuadCache.busy (spec 071 criterion 5)", () => {
  it("is true while prefetched tiles are queued, and false once they are computed or dropped", () => {
    const idle: ((d: { timeRemaining(): number }) => void)[] = [];
    const cache = new QuadCache(GRID, (cb) => { idle.push(cb); });
    expect(cache.busy).toBe(false);
    cache.prefetch(["0,0", "256,0"]);
    expect(cache.busy).toBe(true);
    while (idle.length) idle.shift()!({ timeRemaining: () => 50 });
    expect(cache.busy).toBe(false);
    cache.prefetch(["512,0"]);
    cache.prefetch([]);
    expect(cache.busy).toBe(false);
  });
});
