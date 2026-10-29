import { describe, expect, it } from "vitest";
import { applyAffine, fromLonLat, toLonLat } from "../../../src/core/crs";
import { tileWindows } from "../../../src/core/grid";
import { paintLabels, tileQuads, type Quad } from "../../../src/core/labelQuads";
import { footprintRing } from "../../../src/core/pixel";
import type { Affine, Grid } from "../../../src/core/types";

// Spec 018 criteria 1 and 2: each label tile drawn as raster-aligned quads placed by their corners.
const R = 6378137, D2R = Math.PI / 180;
const merc = (lon: number, lat: number): [number, number] => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
const M = (g: Grid, c: number, r: number) => merc(...toLonLat(g.epsg, ...applyAffine(g.gt, c, r)));
const utmAt = (lon: number, lat: number, gt: (x: number, y: number) => Affine): Grid => {
  const [x, y] = fromLonLat(32633, lon, lat);
  return { epsg: 32633, gt: gt(Math.round(x), Math.round(y)), width: 512, height: 512 };
};

/** Spec 003's EPSG:32633 fixture. */
const UTM_FIXTURE: Grid = { epsg: 32633, gt: [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30], width: 600, height: 520 };
const UTM_60N = utmAt(18, 60, (x, y) => [x, 10, 0, y, 0, -10]);
const GEO_45: Grid = { epsg: 4326, gt: [10, 0.0001, 0, 45.03, 0, -0.0001], width: 512, height: 512 };
const STEP: Grid = { epsg: 4326, gt: [10, 0.01, 0, 85, 0, -0.01], width: 512, height: 2500 };
const ROTATED = utmAt(17, 55, (x, y) => [x, 10, 3, y, 2, -10]);
const MERC: Grid = { epsg: 3857, gt: [1e6, 10, 0, merc(0, 60)[1], 0, -10], width: 600, height: 400 };
const GRIDS: [string, Grid, boolean][] = [
  ["spec 003 EPSG:32633 fixture", UTM_FIXTURE, true],
  ["EPSG:32633 3 deg off the meridian at 60N", UTM_60N, true],
  ["EPSG:4326 at 45N", GEO_45, true],
  ["EPSG:4326 0.01 deg from 85N to 60N", STEP, false],
  ["EPSG:32633 with rotation and shear", ROTATED, false],
  ["EPSG:3857", MERC, true],
];

/** Largest bilinear error over every pixel corner of q, in units of the narrowest width of the pixel at that corner. */
function worstError(g: Grid, q: Quad): number {
  const [tl, tr, br, bl] = q.corners.map((p) => merc(p[0]!, p[1]!)) as [number, number][];
  const { x0, y0, width, height } = q.window;
  let worst = 0;
  for (let r = y0; r <= y0 + height; r++) for (let c = x0; c <= x0 + width; c++) {
    const u = (c - x0) / width, v = (r - y0) / height;
    const at = (k: 0 | 1) => (1 - u) * (1 - v) * tl![k] + u * (1 - v) * tr![k] + u * v * br![k] + (1 - u) * v * bl![k];
    const m = M(g, c, r), p = M(g, c + 1, r), s = M(g, c, r + 1);
    const ax = p[0] - m[0], ay = p[1] - m[1], bx = s[0] - m[0], by = s[1] - m[1];
    const narrow = Math.abs(ax * by - ay * bx) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
    worst = Math.max(worst, Math.hypot(at(0) - m[0], at(1) - m[1]) / narrow);
  }
  return worst;
}

describe("tileQuads (criterion 1)", () => {
  for (const [name, g, single] of GRIDS) {
    it(`bilinear error at most 0.05 px at every pixel corner; quads tile the window with footprintRing's corners: ${name}`, () => {
      let most = 0;
      for (const w of tileWindows(g.width, g.height)) {
        const qs = tileQuads(g, w, 0.05);
        most = Math.max(most, qs.length);
        if (single) expect(qs).toHaveLength(1);
        const cover = new Uint8Array(w.width * w.height);
        let prev: [number, number] = [-1, -1];
        for (const q of qs) {
          const { x0, y0, width, height } = q.window;
          expect(width).toBeGreaterThan(0);
          expect(height).toBeGreaterThan(0);
          expect(y0 > prev[0] || (y0 === prev[0] && x0 > prev[1])).toBe(true); // row-major
          prev = [y0, x0];
          for (let r = y0; r < y0 + height; r++) for (let c = x0; c < x0 + width; c++) cover[(r - w.y0) * w.width + (c - w.x0)]!++;
          const ring = footprintRing(g, q.window).slice(0, 4);
          expect(q.corners).toHaveLength(4);
          q.corners.forEach((p, i) => {
            expect(Math.abs(p[0]! - ring[i]![0])).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(p[1]! - ring[i]![1])).toBeLessThanOrEqual(1e-9);
          });
          expect(worstError(g, q)).toBeLessThanOrEqual(0.05);
        }
        expect(cover.every((n) => n === 1)).toBe(true);
      }
      if (g === STEP) expect(most).toBeGreaterThan(1); // coarse high-latitude pixels need bands
    });
  }

  it("splits into the fewest bands: a band fewer in either direction would exceed the error", () => {
    const w = { x0: 0, y0: 0, width: 256, height: 256 };
    const qs = tileQuads(STEP, w, 0.05);
    const cols = new Set(qs.map((q) => q.window.x0)).size, rows = new Set(qs.map((q) => q.window.y0)).size;
    expect(qs).toHaveLength(cols * rows);
    expect(Math.log2(cols) % 1).toBe(0);
    expect(Math.log2(rows) % 1).toBe(0);
    const bands = (nc: number, nr: number): Quad[] => {
      const out: Quad[] = [];
      for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) {
        const win = { x0: (i * 256) / nc, y0: (j * 256) / nr, width: 256 / nc, height: 256 / nr };
        out.push({ window: win, corners: footprintRing(STEP, win).slice(0, 4) });
      }
      return out;
    };
    const total = cols * rows;
    for (let nc = 1; nc <= 256; nc *= 2) for (let nr = 1; nr <= 256; nr *= 2) {
      if (nc * nr >= total) continue;
      expect(Math.max(...bands(nc, nr).map((q) => worstError(STEP, q)))).toBeGreaterThan(0.05);
    }
  });

  it("splits a partial tile into bands of whole pixels", () => {
    const w = { x0: 0, y0: 2496, width: 100, height: 4 };
    const qs = tileQuads(STEP, w, 1e-6);
    for (const q of qs) expect(Number.isInteger(q.window.x0) && Number.isInteger(q.window.width) && q.window.width >= 1).toBe(true);
    expect(qs.reduce((a, q) => a + q.window.width * q.window.height, 0)).toBe(400);
  });
});

describe("paintLabels (criterion 2)", () => {
  it("gives a labelled pixel its class colour at alpha 255 and 0 alpha 0, texel for texel", () => {
    const labels = Uint8Array.from([0, 1, 2, 0, 2, 1]);
    const rgba = new Uint8ClampedArray(4 * labels.length).fill(77);
    paintLabels(labels, ["#102030", "#ff8001"], rgba);
    expect([...rgba]).toEqual([0, 0, 0, 0, 16, 32, 48, 255, 255, 128, 1, 255, 0, 0, 0, 0, 255, 128, 1, 255, 16, 32, 48, 255]);
  });

  it("leaves a value with no class transparent", () => {
    const rgba = new Uint8ClampedArray(4).fill(9);
    paintLabels(Uint8Array.from([3]), ["#102030"], rgba);
    expect([...rgba]).toEqual([0, 0, 0, 0]);
  });
});
