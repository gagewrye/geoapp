import { describe, expect, it } from "vitest";
import { applyAffine, fromLonLat, toLonLat } from "../../../src/core/crs";
import { tileWindows, type Window } from "../../../src/core/grid";
import { paintLabels, tileQuads, type Quad } from "../../../src/core/labelQuads";
import { MAX_LAT, type Grid } from "../../../src/core/types";

// Tester: spec 018 criterion 1 edge cases. Pole clamp, coarse high-latitude 4326 (many quads), southern and
// antimeridian grids, partial and one-pixel tiles, rasters wholly beyond MAX_LAT.
const R = 6378137, D2R = Math.PI / 180;
const merc = (lon: number, lat: number): [number, number] => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
const lonLat = (g: Grid, c: number, r: number) => toLonLat(g.epsg, ...applyAffine(g.gt, c, r));

/** Largest bilinear error over corners within MAX_LAT, in the narrowest width of the pixel at that corner. */
function worstError(g: Grid, q: Quad): number {
  const [tl, tr, br, bl] = q.corners.map((p) => merc(p[0]!, p[1]!)) as [number, number][];
  const { x0, y0, width, height } = q.window;
  let worst = 0;
  for (let r = y0; r <= y0 + height; r++) for (let c = x0; c <= x0 + width; c++) {
    const ll = lonLat(g, c, r);
    if (Math.abs(ll[1]) > MAX_LAT) continue;
    const u = (c - x0) / width, v = (r - y0) / height;
    const at = (k: 0 | 1) => (1 - u) * (1 - v) * tl![k] + u * (1 - v) * tr![k] + u * v * br![k] + (1 - u) * v * bl![k];
    const m = merc(...ll), p = merc(...lonLat(g, c + 1, r)), s = merc(...lonLat(g, c, r + 1));
    const ax = p[0] - m[0], ay = p[1] - m[1], bx = s[0] - m[0], by = s[1] - m[1];
    const narrow = Math.abs(ax * by - ay * bx) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
    if (!Number.isFinite(narrow) || narrow === 0) continue;
    worst = Math.max(worst, Math.hypot(at(0) - m[0], at(1) - m[1]) / narrow);
  }
  return worst;
}

/** Checks a window's quads: exact cover, finite in-range corners, error bound; returns the quad count. */
function check(g: Grid, w: Window): number {
  const qs = tileQuads(g, w, 0.05);
  const cover = new Uint8Array(w.width * w.height);
  for (const q of qs) {
    const { x0, y0, width, height } = q.window;
    expect(Number.isInteger(x0) && Number.isInteger(y0) && width >= 1 && height >= 1).toBe(true);
    for (let r = y0; r < y0 + height; r++) for (let c = x0; c < x0 + width; c++) cover[(r - w.y0) * w.width + (c - w.x0)]!++;
    for (const [lon, lat] of q.corners) {
      expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
      expect(Math.abs(lat!)).toBeLessThan(90); // MapLibre needs finite Mercator
    }
    expect(worstError(g, q)).toBeLessThanOrEqual(0.05);
  }
  expect(cover.every((n) => n === 1)).toBe(true);
  return qs.length;
}

const checkAll = (g: Grid) => tileWindows(g.width, g.height).map((w) => check(g, w));

describe("tileQuads edge cases (tester, spec 018 criterion 1)", () => {
  it("EPSG:4326 0.01 deg from 87N (past MAX_LAT): corners clamped below 90, error held where it can show", () => {
    const g: Grid = { epsg: 4326, gt: [10, 0.01, 0, 87, 0, -0.01], width: 600, height: 600 };
    checkAll(g);
    const top = tileQuads(g, { x0: 0, y0: 0, width: 256, height: 256 }, 0.05);
    expect(Math.max(...top.flatMap((q) => q.corners.map((p) => p[1]!)))).toBeLessThanOrEqual(89.9);
  });

  it("a 4326 raster reaching the pole itself gives finite corners", () => {
    checkAll({ epsg: 4326, gt: [0, 0.01, 0, 90, 0, -0.01], width: 300, height: 300 });
  });

  it("a raster wholly beyond MAX_LAT gives one finite quad per tile (nothing there can show)", () => {
    const g: Grid = { epsg: 4326, gt: [0, 0.001, 0, 89, 0, -0.001], width: 300, height: 300 };
    expect(checkAll(g).every((n) => n === 1)).toBe(true);
  });

  it("0.05 deg 4326 near 85N: many quads, still within 0.05 px and never more quads than pixels", () => {
    const g: Grid = { epsg: 4326, gt: [0, 0.05, 0, 85, 0, -0.05], width: 512, height: 512 };
    const counts = checkAll(g);
    expect(Math.max(...counts)).toBeGreaterThan(1);
    tileWindows(g.width, g.height).forEach((w, i) => expect(counts[i]!).toBeLessThanOrEqual(w.width * w.height));
  });

  it("southern EPSG:4326 and southern UTM (EPSG:32733) at 60S", () => {
    checkAll({ epsg: 4326, gt: [10, 0.01, 0, -45, 0, -0.01], width: 300, height: 520 });
    const [x, y] = fromLonLat(32733, 18, -60);
    expect(checkAll({ epsg: 32733, gt: [Math.round(x), 10, 0, Math.round(y), 0, -10], width: 512, height: 512 }).every((n) => n === 1)).toBe(true);
  });

  it("EPSG:32660 across 180: longitudes stay continuous, one quad per tile", () => {
    const [x, y] = fromLonLat(32660, 179.6, 10.02);
    const g: Grid = { epsg: 32660, gt: [x, 30, 0, y, 0, -30], width: 3000, height: 120 };
    expect(checkAll(g).every((n) => n === 1)).toBe(true);
    for (const w of tileWindows(g.width, g.height)) for (const q of tileQuads(g, w, 0.05)) {
      const lons = q.corners.map((p) => p[0]!);
      expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(1); // no quad spanning the world
    }
  });

  it("partial tiles of 1 px and odd sizes at the raster edge", () => {
    for (const g of [
      { epsg: 4326, gt: [10, 0.05, 0, 84, 0, -0.05], width: 257, height: 259 },
      { epsg: 4326, gt: [10, 0.0001, 0, 45, 0, -0.0001], width: 1, height: 1 },
      { epsg: 4326, gt: [10, 0.05, 0, 84, 0, -0.05], width: 3, height: 300 },
    ] as Grid[]) checkAll(g);
  });

  it("a grid rotated 90 degrees (column steps south) gives one quad per fine UTM tile", () => {
    const [x, y] = fromLonLat(32633, 15, 50);
    const g: Grid = { epsg: 32633, gt: [Math.round(x), 0, 10, Math.round(y), -10, 0], width: 300, height: 300 };
    expect(checkAll(g).every((n) => n === 1)).toBe(true);
  });
});

describe("paintLabels edge cases (tester, spec 018 criterion 2)", () => {
  it("no classes: every texel transparent; an empty tile is a no-op", () => {
    const rgba = new Uint8ClampedArray(12).fill(200);
    paintLabels(Uint8Array.from([1, 2, 255]), [], rgba);
    expect([...rgba].every((v) => v === 0)).toBe(true);
    paintLabels(new Uint8Array(0), ["#ffffff"], new Uint8ClampedArray(0));
  });

  it("a full 256 x 256 single-class tile is opaque class colour in every texel", () => {
    const labels = new Uint8Array(256 * 256).fill(1), rgba = new Uint8ClampedArray(4 * labels.length);
    paintLabels(labels, ["#0a0b0c"], rgba);
    for (let p = 0; p < labels.length; p++) expect(rgba[4 * p] === 10 && rgba[4 * p + 1] === 11 && rgba[4 * p + 2] === 12 && rgba[4 * p + 3] === 255).toBe(true);
  });
});
