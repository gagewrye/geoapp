import { describe, expect, it, vi } from "vitest";
import * as crs from "../../../src/core/crs";
import { tileWindows, type Window } from "../../../src/core/grid";
import { OVERLAY_SAMPLE, overlayGrid, overlayIndex, paintOverlay, pixelWidths, type OverlayGrid } from "../../../src/core/overlay";
import { MAX_LAT, TILE_SIZE, type Affine, type Grid } from "../../../src/core/types";
import { mercBounds } from "../../../src/core/warp";

vi.mock("../../../src/core/crs", async (orig) => {
  const m = await orig<typeof import("../../../src/core/crs")>();
  return { ...m, toLonLat: vi.fn(m.toLonLat) };
});

// Tester checks of spec 011 criteria 3-5 on grids the implementer's tests don't use, plus the Cost rule's
// sample count measured structurally (projections per tile), not by timing.
const { applyAffine, fromLonLat, invertAffine, toLonLat } = crs;
const R = 6378137, D2R = Math.PI / 180;
const mercX = (lon: number) => R * lon * D2R;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
const lonOf = (x: number) => x / R / D2R;
const latOf = (y: number) => Math.atan(Math.sinh(y / R)) / D2R;
const utm = (epsg: number, lon: number, lat: number, gt: (x: number, y: number) => Affine, width: number, height: number): Grid => {
  const [x, y] = fromLonLat(epsg, lon, lat);
  return { epsg, gt: gt(Math.round(x), Math.round(y)), width, height };
};

const GRIDS: [string, Grid][] = [
  ["EPSG:32733 southern UTM with rotation and shear, partial tiles 600x530", utm(32733, 19, -40, (x, y) => [x, 10, -2.5, y, 1.5, -10], 600, 530)],
  ["EPSG:4326 crossing -MAX_LAT, 300x600 from 83S", { epsg: 4326, gt: [10, 0.01, 0, -83, 0, -0.01], width: 300, height: 600 }],
  ["EPSG:3857 10 m at 60N, 600x400 (Mercator-aligned)", { epsg: 3857, gt: [1e6, 10, 0, mercY(60), 0, -10], width: 600, height: 400 }],
  ["EPSG:4326 non-square pixels 0.01 x 0.002 at 30N, 400x700", { epsg: 4326, gt: [-5, 0.01, 0, 30, 0, -0.002], width: 400, height: 700 }],
  ["EPSG:4326 coarse 0.05 deg from 85N, 300x1100 (several k steps)", { epsg: 4326, gt: [0, 0.05, 0, 85, 0, -0.05], width: 300, height: 1100 }],
];

const bit = (v: Uint8Array, i: number) => (v[i >> 3]! >> (i & 7)) & 1;
const lonLatOf = (g: Grid, c: number, r: number) => toLonLat(g.epsg, ...applyAffine(g.gt, c, r));
const within = (g: Grid, c: number, r: number) => [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]].every(([x, y]) => Math.abs(lonLatOf(g, x!, y!)[1]) <= MAX_LAT);
const keyOf = (w: Window) => `${w.x0},${w.y0}`;

type Ov = ReturnType<typeof overlayIndex> & { w: Window; rgba: Uint8ClampedArray };
function overlays(g: Grid, og: OverlayGrid, ws = tileWindows(g.width, g.height)): Ov[] {
  return ws.map((w) => {
    const o = overlayIndex(w, g, og);
    const rgba = new Uint8ClampedArray(o.width * o.height * 4);
    paintOverlay(o.index, o.valid, new Uint8Array(w.width * w.height).fill(1), ["#ff0000"], rgba);
    return { ...o, w, rgba };
  });
}
function covers(o: Ov, lon: number, lat: number): boolean {
  const [tl, , br] = o.corners;
  const u = Math.floor(((mercX(lon) - mercX(tl![0])) / (mercX(br![0]) - mercX(tl![0]))) * o.width);
  const v = Math.floor(((mercY(tl![1]) - mercY(lat)) / (mercY(tl![1]) - mercY(br![1]))) * o.height);
  return u >= 0 && v >= 0 && u < o.width && v < o.height && o.rgba[4 * (v * o.width + u) + 3] === 255;
}
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("spec 011 criterion 3 (precision) on tester grids", () => {
  for (const [name, g] of GRIDS) {
    it(`every pixel within MAX_LAT holds a valid cell centre of its own tile indexing it; px, py in [0.98, 1] x the minimum: ${name}`, () => {
      const og = overlayGrid(g);
      let mx = Infinity, my = Infinity;
      for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
        const pw = pixelWidths(g, c, r);
        if (pw) { mx = Math.min(mx, pw[0]); my = Math.min(my, pw[1]); }
      }
      expect(og.px).toBeLessThanOrEqual(mx);
      expect(og.py).toBeLessThanOrEqual(my);
      expect(og.px).toBeGreaterThanOrEqual(0.98 * mx);
      expect(og.py).toBeGreaterThanOrEqual(0.98 * my);
      const hit = new Uint8Array(g.width * g.height);
      for (const o of overlays(g, og)) {
        const { w } = o;
        const [tl, , br] = o.corners;
        const cx = (mercX(br![0]) - mercX(tl![0])) / o.width, cy = (mercY(tl![1]) - mercY(br![1])) / o.height;
        for (let v = 0; v < o.height; v++) for (let u = 0; u < o.width; u++) {
          const i = v * o.width + u;
          if (!bit(o.valid, i)) continue;
          expect(o.index[i]!).toBeLessThan(w.width * w.height);
          const [c, r] = invertAffine(g.gt, ...fromLonLat(g.epsg, lonOf(mercX(tl![0]) + (u + 0.5) * cx), latOf(mercY(tl![1]) - (v + 0.5) * cy))).map(Math.floor) as [number, number];
          if (c < w.x0 || c >= w.x0 + w.width || r < w.y0 || r >= w.y0 + w.height) continue;
          if (o.index[i] === (r - w.y0) * w.width + (c - w.x0)) hit[r * g.width + c] = 1;
        }
      }
      const missed: string[] = [];
      for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) if (!hit[r * g.width + c] && within(g, c, r)) missed.push(`${c},${r}`);
      expect(missed.slice(0, 5), `${missed.length} pixels missed`).toEqual([]);
    }, 180_000);
  }
});

describe("spec 011 criterion 4 (no gaps where k steps) on tester grids", () => {
  for (const [name, g] of GRIDS) {
    it(`every 2x2 block: interior points covered at least once, twice only beside a seam where k steps: ${name}`, () => {
      const og = overlayGrid(g);
      const all = overlays(g, og);
      const byKey = new Map(all.map((o) => [keyOf(o.w), o]));
      const k = (x0: number, y0: number) => og.k.get(`${x0},${y0}`)!;
      const rand = rng(99);
      const bad: string[] = [];
      for (let by = 0; by + TILE_SIZE < g.height; by += TILE_SIZE) for (let bx = 0; bx + TILE_SIZE < g.width; bx += TILE_SIZE) {
        const ws = [[bx, by], [bx + TILE_SIZE, by], [bx, by + TILE_SIZE], [bx + TILE_SIZE, by + TILE_SIZE]];
        const ovs = ws.map(([x, y]) => byKey.get(`${x},${y}`)!);
        const bw = Math.min(512, g.width - bx), bh = Math.min(512, g.height - by);
        const ks = ws.map(([x, y]) => k(x!, y!));
        const steps = new Set(ks.map((v) => v.join())).size > 1;
        // the coarsest cell of the block, in raster px along each axis (an upper bound on the allowed overlap band)
        const cell = Math.max(...ks.map(([kx, ky]) => Math.max(kx * og.px, ky * og.py)));
        for (let i = 0; i < 1500; i++) {
          const c = bx + 2 + rand() * (bw - 4), r = by + 2 + rand() * (bh - 4);
          const [lon, lat] = lonLatOf(g, c, r);
          if (Math.abs(lat) > MAX_LAT - 0.05) continue; // pixels straddling MAX_LAT are out of scope
          const n = ovs.filter((o) => covers(o, lon, lat)).length;
          if (n === 0) { bad.push(`gap at (${c.toFixed(2)}, ${r.toFixed(2)})`); continue; }
          if (n === 1) continue;
          if (!steps) { bad.push(`overlap ${n} with equal k at (${c.toFixed(2)}, ${r.toFixed(2)})`); continue; }
          // distance to the nearest seam in Mercator, measured along the seam's normal through raster neighbours
          const [mx, my] = [mercX(lon), mercY(lat)];
          const seamDist = Math.min(
            ...[[bx + TILE_SIZE, r], [c, by + TILE_SIZE]].map(([sc, sr], axis) => {
              const p = axis === 0 ? lonLatOf(g, sc!, r) : lonLatOf(g, c, sr!);
              return Math.hypot(mercX(p[0]) - mx, mercY(p[1]) - my);
            }),
          );
          if (seamDist > 1.5 * cell) bad.push(`overlap ${n} ${seamDist.toFixed(0)} m from a seam (cell ${cell.toFixed(0)} m) at (${c.toFixed(2)}, ${r.toFixed(2)})`);
        }
      }
      expect(bad.slice(0, 5), `${bad.length} bad points`).toEqual([]);
    }, 180_000);
  }

  it("the step grids do step (k differs between tiles), so the checks above exercise overlap", () => {
    for (const [, g] of GRIDS.slice(4)) {
      const og = overlayGrid(g);
      expect(new Set([...og.k.values()].map((v) => v.join())).size).toBeGreaterThan(1);
    }
  });
});

describe("spec 011 criterion 5 (size) on tester grids", () => {
  for (const [name, g] of GRIDS) {
    it(`powers of two; within ceil(bbox side / (k p)) + 2; index and validity lengths: ${name}`, () => {
      const og = overlayGrid(g);
      expect(og.k.size).toBe(tileWindows(g.width, g.height).length);
      for (const w of tileWindows(g.width, g.height)) {
        const [kx, ky] = og.k.get(keyOf(w))!;
        for (const kk of [kx, ky]) { expect(kk).toBeGreaterThanOrEqual(1); expect(Number.isInteger(Math.log2(kk))).toBe(true); }
        const o = overlayIndex(w, g, og);
        const [x0, y0, x1, y1] = mercBounds(w, g.gt, g.epsg);
        expect(o.width).toBeLessThanOrEqual(Math.ceil((x1 - x0) / (kx * og.px)) + 2);
        expect(o.height).toBeLessThanOrEqual(Math.ceil((y1 - y0) / (ky * og.py)) + 2);
        expect(o.index).toBeInstanceOf(Uint16Array);
        expect(o.index.length).toBe(o.width * o.height);
        expect(o.valid.length).toBe(Math.ceil((o.width * o.height) / 8));
      }
    }, 60_000);
  }
});

describe("spec 011 Cost: overlayGrid's projections (structural)", () => {
  const samples = (n: number) => Math.ceil(n / OVERLAY_SAMPLE) + ((n - 1) % OVERLAY_SAMPLE === 0 ? 0 : 1);
  it("projects 3 points per sample: 289 samples per full tile, fewer for partial ones, on a 4096x2100 UTM raster", () => {
    const g = utm(32633, 18, 50, (x, y) => [x, 10, 0, y, 0, -10], 4096, 2100);
    const spy = vi.mocked(toLonLat);
    spy.mockClear();
    overlayGrid(g);
    const want = tileWindows(g.width, g.height).reduce((n, w) => n + samples(w.width) * samples(w.height), 0);
    expect(samples(TILE_SIZE) ** 2).toBe(289);
    expect(spy.mock.calls.length).toBe(3 * want);
  });
});
