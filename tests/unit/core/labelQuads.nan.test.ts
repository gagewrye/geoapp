import { afterEach, describe, expect, it, vi } from "vitest";
import * as crs from "../../../src/core/crs";
import { applyAffine, toLonLat } from "../../../src/core/crs";
import { latticeQuads, tileQuads, type Quad } from "../../../src/core/labelQuads";
import { MAX_LAT, type Grid } from "../../../src/core/types";

// Spec 029 criterion 1: lattice points whose projection isn't finite neither halve the lattice nor spread NaN.
const R = 6378137, D2R = Math.PI / 180;
const merc = (lon: number, lat: number): [number, number] => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
const FULL = { x0: 0, y0: 0, width: 256, height: 256 };
const real = toLonLat;

/** Quads with 4 finite corners: every pixel corner with a finite position is within 0.055 px (spec 026 criterion 1). */
function expectFiniteAccurate(g: Grid, qs: Quad[], project: (c: number, r: number) => [number, number]) {
  const M = (c: number, r: number) => merc(...project(c, r));
  for (const q of qs) {
    if (!q.corners.flat().every(Number.isFinite)) continue;
    const [tl, tr, br, bl] = q.corners.map((p) => merc(p[0]!, p[1]!)) as [number, number][];
    const { x0, y0, width, height } = q.window;
    for (let r = y0; r <= y0 + height; r++) for (let c = x0; c <= x0 + width; c++) {
      const m = M(c, r), p = M(c + 1, r), s = M(c, r + 1);
      if (![...m, ...p, ...s].every(Number.isFinite) || Math.abs(project(c, r)[1]) > MAX_LAT) continue;
      const u = (c - x0) / width, v = (r - y0) / height;
      const bi = (k: 0 | 1) => (1 - u) * (1 - v) * tl![k] + u * (1 - v) * tr![k] + u * v * br![k] + (1 - u) * v * bl![k];
      const ax = p[0] - m[0], ay = p[1] - m[1], bx = s[0] - m[0], by = s[1] - m[1];
      const narrow = Math.abs(ax * by - ay * bx) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
      expect(Math.hypot(bi(0) - m[0], bi(1) - m[1]) / narrow).toBeLessThanOrEqual(0.055);
    }
  }
}

/** No returned corner is NaN where the exact projection of that pixel corner is finite. */
function expectNoLostCorners(g: Grid, qs: Quad[], project: (c: number, r: number) => [number, number]) {
  for (const q of qs) {
    const { x0, y0, width, height } = q.window;
    const xy = [[x0, y0], [x0 + width, y0], [x0 + width, y0 + height], [x0, y0 + height]] as const;
    q.corners.forEach(([lon, lat], k) => {
      const e = project(xy[k]![0], xy[k]![1]);
      if (Number.isFinite(e[0]) && Number.isFinite(e[1])) expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
    });
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe("non-finite lattice points (spec 029 criterion 1)", () => {
  it("EPSG:32618 far east of its zone (centres project to NaN): at most 600 projections, nothing lost, finite corners accurate", () => {
    const g: Grid = { epsg: 32618, gt: [2e7, 1000, 0, 5e6, 0, -1000], width: 256, height: 256 };
    const project = (c: number, r: number) => real(g.epsg, ...applyAffine(g.gt, c, r));
    expect(Number.isFinite(project(8, 8)[0])).toBe(false);
    const spy = vi.spyOn(crs, "toLonLat");
    const qs = tileQuads(g, FULL, 0.05);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(600);
    spy.mockRestore();
    expectNoLostCorners(g, qs, project);
    expectFiniteAccurate(g, qs, project);
  });

  // proj4's inverses give NaN latitude only in some cases; a projection doing so everywhere must not halve to step 1
  it("a projection giving [NaN, NaN] everywhere makes at most 600 projections", () => {
    const g: Grid = { epsg: 32633, gt: [500000, 30, 0, 5e6, 0, -30], width: 256, height: 256 };
    const spy = vi.spyOn(crs, "toLonLat").mockImplementation(() => [NaN, NaN]);
    const { lattice } = latticeQuads(g, FULL, 0.05, 16);
    expect(lattice).toBe(16);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(600);
  });

  it("NaN on part of a tile: corners where the projection is finite stay finite and accurate", () => {
    const g: Grid = { epsg: 32633, gt: [500000, 30, 0, 5e6, 0, -30], width: 256, height: 256 };
    // NaN east of x = 503,610 (column 120.33), as past a projection's edge
    const project = (c: number, r: number): [number, number] => { const [x, y] = applyAffine(g.gt, c, r); return x > 503610 ? [NaN, NaN] : real(32633, x, y); };
    vi.spyOn(crs, "toLonLat").mockImplementation((_e, x, y) => (x > 503610 ? [NaN, NaN] : real(32633, x, y)));
    const { quads, lattice } = latticeQuads(g, FULL, 0.05, 16);
    expect(lattice).toBe(16);
    vi.restoreAllMocks();
    expectNoLostCorners(g, quads, project);
    expectFiniteAccurate(g, quads, project);
  });
});
