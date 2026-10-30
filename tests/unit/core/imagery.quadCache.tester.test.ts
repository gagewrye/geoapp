import { afterEach, describe, expect, it, vi } from "vitest";
import { fromLonLat } from "../../../src/core/crs";
import { tileWindows } from "../../../src/core/grid";
import { imageryQuads, type Level, type QuadCache } from "../../../src/core/imagery";
import * as labelQuads from "../../../src/core/labelQuads";
import type { Grid } from "../../../src/core/types";

// Tester, spec 026 scope 3: the imagery quad cache keys by level, works without a cache, and stays small per tile.
afterEach(() => { vi.restoreAllMocks(); });

const [gx, gy] = fromLonLat(32618, -77.16, 17.83);
const GAGE: Grid = { epsg: 32618, gt: [Math.round(gx), 0.1, 0, Math.round(gy), 0, -0.1], width: 1000, height: 700 };
const SPEC_003: Grid = { epsg: 32633, gt: [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30], width: 600, height: 520 };
const W = { x0: 0, y0: 0, width: 256, height: 256 };

describe("imageryQuads cache (tester, spec 026)", () => {
  it("the same key at two levels is two entries: a level's quads never come from another level", () => {
    const spy = vi.spyOn(labelQuads, "tileQuads");
    const cache: QuadCache = new Map();
    const a: Level = { s: 1, grid: GAGE, overview: null };
    const b: Level = { s: 2, grid: { ...GAGE, gt: [GAGE.gt[0], 0.2, 0, GAGE.gt[3], 0, -0.2] }, overview: 0 };
    const qa = imageryQuads(a, W, cache, "k"), qb = imageryQuads(b, W, cache, "k");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(qb).not.toEqual(qa);
    expect(imageryQuads(a, W, cache, "k")).toBe(qa);
    expect(imageryQuads(b, W, cache, "k")).toBe(qb);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("with no cache, or a cache but no key, it computes every time and stores nothing", () => {
    const spy = vi.spyOn(labelQuads, "tileQuads");
    const level: Level = { s: 1, grid: GAGE, overview: null };
    const cache: QuadCache = new Map();
    imageryQuads(level, W);
    imageryQuads(level, W);
    imageryQuads(level, W, cache);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
  });

  it("cached and uncached quads are equal, so the cache never changes placement", () => {
    const level: Level = { s: 1, grid: GAGE, overview: null };
    const cache: QuadCache = new Map();
    imageryQuads(level, W, cache, "k");
    expect(imageryQuads(level, W, cache, "k")).toEqual(labelQuads.tileQuads(GAGE, W, labelQuads.QUAD_ERR));
  });

  it.each([["UTM 18N 0.1 m", GAGE], ["spec 003 EPSG:32633", SPEC_003]] as const)(
    "an entry's corners stay under 1 KiB for every tile: %s", (_n, g) => {
      const cache: QuadCache = new Map();
      for (const w of tileWindows(g.width, g.height)) imageryQuads({ s: 1, grid: g, overview: null }, w, cache, `${w.x0},${w.y0}`);
      for (const qs of cache.values()) expect(qs.length * 4 * 2 * 8).toBeLessThan(1024);
    });
});
