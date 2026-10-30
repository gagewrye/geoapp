import { describe, expect, it } from "vitest";
import { QUAD_ERR, tileQuads } from "../../../src/core/labelQuads";
import { tileWindow } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { QuadCache } from "../../../src/map/quadCache";

// Spec 023 review 2, tester: with no prefetch (during a stroke, or idle never comes), a first-drawn tile still gets its quads at once.

const GRID: Grid = { width: 3000, height: 2000, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };

describe("QuadCache with no idle time", () => {
  it("get computes a tile's quads on demand, equal to tileQuads, and the prefetch never runs", () => {
    const never: (() => void)[] = [];
    const cache = new QuadCache(GRID, (cb) => { never.push(() => cb({ timeRemaining: () => 50 })); });
    cache.prefetch([]); // what a hover during a stroke does
    for (const key of ["0,0", "2816,1792", "256,512"]) { // a full tile, the partial corner tile, an inner tile
      const [x0, y0] = key.split(",").map(Number) as [number, number];
      const got = cache.get(key);
      expect(got.length).toBeGreaterThan(0);
      expect(got).toEqual(tileQuads(GRID, tileWindow(GRID, x0, y0), QUAD_ERR));
      expect(cache.get(key)).toBe(got); // kept, not computed again
    }
    expect(never).toHaveLength(0);
  });
});
