import { afterEach, describe, expect, it, vi } from "vitest";
import * as crs from "../../../src/core/crs";
import { applyAffine, fromLonLat, toLonLat } from "../../../src/core/crs";
import { decimatedAffine } from "../../../src/core/decimate";
import { tileWindows, type Window } from "../../../src/core/grid";
import { LATTICE, LATTICE_TOL, latticeQuads, tileQuads, type Quad } from "../../../src/core/labelQuads";
import { MAX_LAT, type Affine, type Grid } from "../../../src/core/types";

// Spec 026 criteria 1-4: tile quads from a self-checked projected lattice (ADR 0023).
const R = 6378137, D2R = Math.PI / 180;
const merc = (lon: number, lat: number): [number, number] => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
const M = (g: Grid, c: number, r: number) => merc(...toLonLat(g.epsg, ...applyAffine(g.gt, c, r)));
const at = (epsg: number, lon: number, lat: number, px: number, size = 512): Grid => {
  const [x, y] = fromLonLat(epsg, lon, lat);
  return { epsg, gt: [Math.round(x), px, 0, Math.round(y), 0, -px], width: size, height: size };
};
const geo = (lat: number, px: number, size = 512): Grid => ({ epsg: 4326, gt: [10, px, 0, lat + (px * size) / 2, 0, -px], width: size, height: size });
const decimated = (g: Grid, s: number): Grid => ({ ...g, gt: decimatedAffine(g.gt, s) as Affine, width: Math.ceil(g.width / s), height: Math.ceil(g.height / s) });

/** Spec 003's EPSG:32633 fixture. */
const SPEC_003: Grid = { epsg: 32633, gt: [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30], width: 600, height: 520 };
/** Gage's chunks: UTM 18N at 0.1 m, near 77.16 W 17.83 N. */
const GAGE = at(32618, -77.16, 17.83, 0.1);
const BASE: [string, Grid][] = [
  ["spec 003 EPSG:32633", SPEC_003],
  ["UTM 18N 0.1 m", GAGE],
  ["EPSG:4326 at 0", geo(0, 0.001)],
  ["EPSG:4326 at 60", geo(60, 0.001)],
  ["EPSG:4326 at 84", geo(84, 0.001, 256)],
  ["30 m UTM at 63 N", at(32633, 18, 63, 30)],
];
const GRIDS: [string, Grid][] = BASE.flatMap(([n, g]): [string, Grid][] => [[n, g], [`${n}, s = 4`, decimated(g, 4)]]);

/** Largest error over every pixel corner of q, in narrowest widths of the pixel at that corner; corners beyond MAX_LAT aren't shown. */
function worstError(g: Grid, q: Quad): number {
  const [tl, tr, br, bl] = q.corners.map((p) => merc(p[0]!, p[1]!)) as [number, number][];
  const { x0, y0, width, height } = q.window;
  let worst = 0;
  for (let r = y0; r <= y0 + height; r++) for (let c = x0; c <= x0 + width; c++) {
    if (Math.abs(toLonLat(g.epsg, ...applyAffine(g.gt, c, r))[1]) > MAX_LAT) continue;
    const u = (c - x0) / width, v = (r - y0) / height;
    const bi = (k: 0 | 1) => (1 - u) * (1 - v) * tl![k] + u * (1 - v) * tr![k] + u * v * br![k] + (1 - u) * v * bl![k];
    const m = M(g, c, r), p = M(g, c + 1, r), s = M(g, c, r + 1);
    const ax = p[0] - m[0], ay = p[1] - m[1], bx = s[0] - m[0], by = s[1] - m[1];
    const narrow = Math.abs(ax * by - ay * bx) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
    worst = Math.max(worst, Math.hypot(bi(0) - m[0], bi(1) - m[1]) / narrow);
  }
  return worst;
}

/** Quads tile w exactly, row-major, and every corner is within 0.055 px of its true position. */
function expectAccurate(g: Grid, w: Window, qs: Quad[]) {
  const cover = new Uint8Array(w.width * w.height);
  for (const q of qs) {
    const { x0, y0, width, height } = q.window;
    for (let r = y0; r < y0 + height; r++) for (let c = x0; c < x0 + width; c++) cover[(r - w.y0) * w.width + (c - w.x0)]!++;
    expect(worstError(g, q)).toBeLessThanOrEqual(0.055);
  }
  expect(cover.every((n) => n === 1)).toBe(true);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("lattice tile quads (spec 026)", () => {
  it("uses a 16 px lattice and a 0.005 px self-check", () => {
    expect([LATTICE, LATTICE_TOL]).toEqual([16, 0.005]);
  });

  it.each(GRIDS)("criterion 1: every pixel corner within 0.055 px of its true position: %s", (_n, g) => {
    for (const w of tileWindows(g.width, g.height)) expectAccurate(g, w, tileQuads(g, w, 0.05));
  });

  it.each(GRIDS)("criterion 2: as many bands as the exact algorithm, or one subdivision step more: %s", (_n, g) => {
    for (const w of tileWindows(g.width, g.height)) {
      const n = tileQuads(g, w, 0.05).length, exact = latticeQuads(g, w, 0.05, 1).quads.length;
      expect(n === exact || n === 2 * exact).toBe(true);
    }
  });

  it("criterion 3: a 256 x 256 tile of the UTM 18N 0.1 m grid makes at most 600 projections", () => {
    const spy = vi.spyOn(crs, "toLonLat");
    const qs = tileQuads(GAGE, { x0: 256, y0: 0, width: 256, height: 256 }, 0.05);
    expect(qs).toHaveLength(1);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(600);
  });

  it("criterion 4: a grid too curved for the 16 px lattice halves it and stays accurate", () => {
    const g: Grid = { epsg: 4326, gt: [10, 0.02, 0, 85, 0, -0.02], width: 256, height: 256 };
    const w = { x0: 0, y0: 0, width: 256, height: 256 };
    const { quads, lattice } = latticeQuads(g, w, 0.05, LATTICE);
    expect(lattice).toBeLessThan(LATTICE);
    expect(quads).toEqual(tileQuads(g, w, 0.05));
    expectAccurate(g, w, quads);
  });
});
