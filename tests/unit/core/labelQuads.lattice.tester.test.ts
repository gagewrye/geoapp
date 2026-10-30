import { afterEach, describe, expect, it, vi } from "vitest";
import * as crs from "../../../src/core/crs";
import { applyAffine, fromLonLat, toLonLat } from "../../../src/core/crs";
import { tileWindows, type Window } from "../../../src/core/grid";
import { LATTICE, latticeQuads, tileQuads, type Quad } from "../../../src/core/labelQuads";
import { MAX_LAT, type Grid } from "../../../src/core/types";

// Tester, spec 026: the lattice at intermediate steps (8, 4, 2), partial and offset windows, projection reuse
// across halvings, rasters beyond MAX_LAT and projections that give NaN.
const R = 6378137, D2R = Math.PI / 180;
const merc = (lon: number, lat: number): [number, number] => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
const geo = (lat: number, px: number, size = 256): Grid => ({ epsg: 4326, gt: [10, px, 0, lat, 0, -px], width: size, height: size });
const GAGE: Grid = (() => {
  const [x, y] = fromLonLat(32618, -77.16, 17.83);
  return { epsg: 32618, gt: [Math.round(x), 0.1, 0, Math.round(y), 0, -0.1], width: 1000, height: 700 };
})();

/** Every pixel corner within 0.055 px, exact cover, and quad corners projected exactly (spec 018: footprintRing's). */
function expectAccurate(g: Grid, w: Window, qs: Quad[]) {
  const cover = new Uint8Array(w.width * w.height);
  // every corner of the window and the ring beyond it projected once, not once per use
  const W = w.width + 2, ll = new Float64Array(2 * W * (w.height + 2)), mm = new Float64Array(ll.length);
  for (let r = 0; r < w.height + 2; r++) for (let c = 0; c < W; c++) {
    const [lon, la] = toLonLat(g.epsg, ...applyAffine(g.gt, w.x0 + c, w.y0 + r)), i = 2 * (r * W + c);
    [ll[i], ll[i + 1]] = [lon, la];
    [mm[i], mm[i + 1]] = merc(lon, la);
  }
  const lat = (c: number, r: number) => ll[2 * ((r - w.y0) * W + c - w.x0) + 1]!;
  const proj = (c: number, r: number): [number, number] => { const i = 2 * ((r - w.y0) * W + c - w.x0); return [mm[i]!, mm[i + 1]!]; };
  for (const q of qs) {
    const { x0, y0, width, height } = q.window;
    expect(width >= 1 && height >= 1).toBe(true);
    for (let r = y0; r < y0 + height; r++) for (let c = x0; c < x0 + width; c++) cover[(r - w.y0) * w.width + (c - w.x0)]!++;
    const xy = [[x0, y0], [x0 + width, y0], [x0 + width, y0 + height], [x0, y0 + height]] as const;
    q.corners.forEach(([lon, lat], k) => {
      const [elon, elat] = toLonLat(g.epsg, ...applyAffine(g.gt, xy[k]![0], xy[k]![1]));
      expect(Math.abs(lon! - elon)).toBeLessThan(1e-9);
      if (Math.abs(elat) < 89.9) expect(Math.abs(lat! - elat)).toBeLessThan(1e-9);
    });
    const [tl, tr, br, bl] = q.corners.map((p) => merc(p[0]!, p[1]!)) as [number, number][];
    let worst = 0, at = "";
    for (let r = y0; r <= y0 + height; r++) for (let c = x0; c <= x0 + width; c++) {
      if (Math.abs(lat(c, r)) > MAX_LAT) continue;
      const u = (c - x0) / width, v = (r - y0) / height;
      const bi = (k: 0 | 1) => (1 - u) * (1 - v) * tl![k] + u * (1 - v) * tr![k] + u * v * br![k] + (1 - u) * v * bl![k];
      const m = proj(c, r), p = proj(c + 1, r), s = proj(c, r + 1);
      const ax = p[0] - m[0], ay = p[1] - m[1], bx = s[0] - m[0], by = s[1] - m[1];
      const narrow = Math.abs(ax * by - ay * bx) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
      const e = Math.hypot(bi(0) - m[0], bi(1) - m[1]) / narrow;
      if (!(e <= worst)) { worst = e; at = `${c},${r}`; }
    }
    // one expect per quad: an expect per pixel corner made this test take seconds (spec 029)
    expect(worst, `worst at ${at}`).toBeLessThanOrEqual(0.055);
  }
  expect(cover.every((n) => n === 1)).toBe(true);
}

const realToLonLat = crs.toLonLat;
afterEach(() => { vi.restoreAllMocks(); });

// Probed: these settle on lattice 8, 4, 2 and 1 for a full 256 x 256 tile.
const CURVED: [string, Grid, number][] = [
  ["4326 at 60, 0.005 deg", geo(60, 0.005), 8],
  ["4326 at 80, 0.002 deg", geo(80, 0.002), 4],
  ["4326 at 80, 0.005 deg", geo(80, 0.005), 2],
  ["4326 at 84, 0.01 deg", geo(84, 0.01), 1],
];
const FULL: Window = { x0: 0, y0: 0, width: 256, height: 256 };

describe("lattice at intermediate steps (tester, spec 026 criteria 1, 2, 4)", () => {
  it.each(CURVED)("%s: settles on the expected step, accurate, band count exact or doubled", (_n, g, step) => {
    const { quads, lattice } = latticeQuads(g, FULL, 0.05, LATTICE);
    expect(lattice).toBe(step);
    expectAccurate(g, FULL, quads);
    const exact = latticeQuads(g, FULL, 0.05, 1).quads.length;
    expect(quads.length === exact || quads.length === 2 * exact).toBe(true);
  });

  it.each(CURVED)("%s: halving reuses projections, so no corner is projected twice", (_n, g) => {
    const seen = new Set<string>();
    const spy = vi.spyOn(crs, "toLonLat").mockImplementation((epsg, x, y) => {
      const k = `${x},${y}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      return realToLonLat(epsg, x, y);
    });
    tileQuads(g, FULL, 0.05);
    expect(seen.size).toBeGreaterThan(324);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(258 * 258);
  });
});

describe("partial and offset windows (tester, spec 026 criterion 1 at raster edges)", () => {
  const sizes: [number, number][] = [[1, 1], [1, 256], [256, 1], [2, 3], [15, 17], [16, 16], [17, 33], [100, 7], [255, 129]];
  it.each(CURVED)("%s: every partial window size accurate, with an offset origin", (_n, g) => {
    for (const [width, height] of sizes) {
      const w = { x0: 37, y0: 11, width, height };
      expectAccurate(g, w, tileQuads(g, w, 0.05));
    }
  });

  it("Gage's grid: every tile of a 1000 x 700 raster (partial on both edges) is accurate", () => {
    for (const w of tileWindows(GAGE.width, GAGE.height)) expectAccurate(GAGE, w, tileQuads(GAGE, w, 0.05));
  });
});

describe("projection count (tester, spec 026 criterion 3)", () => {
  it("every tile of Gage's 1000 x 700 raster, full or partial, makes at most 600 projections and keeps the 16 px lattice", () => {
    for (const w of tileWindows(GAGE.width, GAGE.height)) {
      const spy = vi.spyOn(crs, "toLonLat");
      const { lattice } = latticeQuads(GAGE, w, 0.05, LATTICE);
      expect(lattice).toBe(LATTICE);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(600);
      spy.mockRestore();
    }
  });

  it("a raster wholly beyond MAX_LAT never halves: nothing there can show", () => {
    const g = geo(89.5, 0.001);
    const spy = vi.spyOn(crs, "toLonLat");
    const { quads, lattice } = latticeQuads(g, FULL, 0.05, LATTICE);
    expect(lattice).toBe(LATTICE);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(600);
    for (const q of quads) for (const [lon, lat] of q.corners) expect(Number.isFinite(lon) && Math.abs(lat!) < 90).toBe(true);
  });

  it("a window straddling MAX_LAT stays accurate where it can show", () => {
    const g = geo(MAX_LAT + 0.1, 0.002);
    expectAccurate(g, FULL, tileQuads(g, FULL, 0.05));
  });
});

describe("projections that give NaN (tester)", () => {
  it("UTM far outside its zone: the lattice gives the same quads as projecting every corner", () => {
    const g: Grid = { epsg: 32633, gt: [1e8, 30, 0, 5e6, 0, -30], width: 256, height: 256 };
    expect(tileQuads(g, FULL, 0.05)).toEqual(latticeQuads(g, FULL, 0.05, 1).quads);
  });
});
