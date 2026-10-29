import { describe, expect, it } from "vitest";
import { applyAffine, fromLonLat, invertAffine, toLonLat } from "../../../src/core/crs";
import { tileWindows, type Window } from "../../../src/core/grid";
import { OVERLAY_MARGIN, OVERLAY_SAMPLE, overlayGrid, overlayIndex, paintOverlay, pixelWidths, type OverlayGrid } from "../../../src/core/overlay";
import { MAX_LAT, TILE_SIZE, type Affine, type Grid } from "../../../src/core/types";
import { mercBounds } from "../../../src/core/warp";

// Spec 011: one Mercator cell grid per raster, sized to the finest pixel, with power-of-two coarser cells per tile.
const R = 6378137, D2R = Math.PI / 180;
const mercX = (lon: number) => R * lon * D2R;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
const lonOf = (x: number) => x / R / D2R;
const latOf = (y: number) => Math.atan(Math.sinh(y / R)) / D2R;
const key = (w: Window) => `${w.x0},${w.y0}`;
const bit = (valid: Uint8Array, i: number) => (valid[i >> 3]! >> (i & 7)) & 1;

/** Spec 003's EPSG:32633 fixture. */
const UTM_FIXTURE: Grid = { epsg: 32633, gt: [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30], width: 600, height: 520 };
/** EPSG:32633, 3 degrees east of its central meridian (15E) at 60N, 10 m pixels. */
const UTM_SYNTH: Grid = (() => {
  const [x, y] = fromLonLat(32633, 18, 60);
  return { epsg: 32633, gt: [Math.round(x), 10, 0, Math.round(y), 0, -10] as Affine, width: 512, height: 512 };
})();
const GEO_45: Grid = { epsg: 4326, gt: [10, 0.0001, 0, 45.03, 0, -0.0001], width: 512, height: 512 };
const GRIDS: [string, Grid][] = [["spec 003 EPSG:32633 fixture", UTM_FIXTURE], ["EPSG:32633 3 deg off the meridian at 60N", UTM_SYNTH], ["EPSG:4326 at 45N", GEO_45]];
const SOUTH: Grid = { epsg: 4326, gt: [10, 0.01, 0, -45, 0, -0.01], width: 300, height: 520 };
const N87: Grid = { epsg: 4326, gt: [10, 0.01, 0, 87, 0, -0.01], width: 600, height: 600 };
/** 0.01 degree pixels from 85N down to 60N: ky steps with latitude. */
const STEP: Grid = { epsg: 4326, gt: [10, 0.01, 0, 85, 0, -0.01], width: 512, height: 2500 };
const ROTATED: Grid = (() => {
  const [x, y] = fromLonLat(32633, 17, 55);
  return { epsg: 32633, gt: [Math.round(x), 10, 3, Math.round(y), 2, -10] as Affine, width: 512, height: 512 };
})();
const MORE: [string, Grid][] = [["tester's southern EPSG:4326, 300x520", SOUTH], ["EPSG:4326 600x600 from 87N", N87],
  ["EPSG:4326 60-85N (k steps)", STEP], ["EPSG:32633 with rotation and shear", ROTATED]];

type Ov = ReturnType<typeof overlayIndex> & { w: Window; rgba: Uint8ClampedArray };
function overlays(g: Grid, og: OverlayGrid, ws: Window[]): Ov[] {
  return ws.map((w) => {
    const o = overlayIndex(w, g, og);
    const rgba = new Uint8ClampedArray(o.width * o.height * 4);
    paintOverlay(o.index, o.valid, new Uint8Array(w.width * w.height).fill(1), ["#ff0000"], rgba);
    return { ...o, w, rgba };
  });
}
/** The overlay cell covering lon/lat, or -1. */
function cellAt(o: Ov, lon: number, lat: number): number {
  const [tl, , br] = o.corners as [number, number][];
  const u = Math.floor(((mercX(lon) - mercX(tl![0])) / (mercX(br![0]) - mercX(tl![0]))) * o.width);
  const v = Math.floor(((mercY(tl![1]) - mercY(lat)) / (mercY(tl![1]) - mercY(br![1]))) * o.height);
  return u >= 0 && v >= 0 && u < o.width && v < o.height ? v * o.width + u : -1;
}
const covers = (o: Ov, lon: number, lat: number) => { const i = cellAt(o, lon, lat); return i >= 0 && o.rgba[4 * i + 3] === 255; };
const blockOf = (g: Grid, x0 = 0, y0 = 0) => tileWindows(g.width, g.height).filter((w) => w.x0 >= x0 && w.x0 < x0 + 512 && w.y0 >= y0 && w.y0 < y0 + 512);
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lonLatOf = (g: Grid, c: number, r: number) => toLonLat(g.epsg, ...applyAffine(g.gt, c, r));
const within = (g: Grid, c: number, r: number) => [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]].every(([x, y]) => Math.abs(lonLatOf(g, x!, y!)[1]) <= MAX_LAT);

describe("pixelWidths and overlayGrid", () => {
  it("has the spec's constants", () => {
    expect(OVERLAY_SAMPLE).toBe(16);
    expect(OVERLAY_MARGIN).toBe(0.98);
  });

  it("gives a Mercator-aligned pixel its own sides, and null for a pixel crossing MAX_LAT", () => {
    const [wx, wy] = pixelWidths(GEO_45, 10, 10)!;
    const [lon, lat] = lonLatOf(GEO_45, 10, 10);
    expect(wx).toBeCloseTo(mercX(lon + 0.0001) - mercX(lon), 6);
    expect(wy).toBeCloseTo(mercY(lat) - mercY(lat - 0.0001), 4);
    expect(pixelWidths(N87, 0, 0)).toBeNull(); // 87N
    expect(pixelWidths(N87, 0, 300)).not.toBeNull(); // 84N
    expect(pixelWidths(N87, 0, Math.floor((87 - MAX_LAT) / 0.01))).toBeNull(); // straddles MAX_LAT
  });
});

describe("overlay partition (spec 011 criterion 1, regression)", () => {
  for (const [name, g] of GRIDS) {
    it(`all k are 1, and exactly one overlay covers each of 10,000 points: ${name}`, () => {
      const og = overlayGrid(g);
      for (const k of og.k.values()) expect(k).toEqual([1, 1]);
      const ovs = overlays(g, og, blockOf(g));
      const rand = rng(11);
      const bad: string[] = [];
      for (let i = 0; i < 10_000; i++) {
        const c = 2 + rand() * 508, r = 2 + rand() * 508;
        const [lon, lat] = lonLatOf(g, c, r);
        const n = ovs.filter((o) => covers(o, lon, lat)).length;
        if (n !== 1) bad.push(`(${c.toFixed(2)}, ${r.toFixed(2)}): ${n}`);
      }
      expect(bad.slice(0, 5), `${bad.length} points`).toEqual([]);
    });
  }
});

describe("overlay completeness (spec 011 criterion 2, brute force)", () => {
  it("every cell whose centre maps into tile w is valid in w's overlay, indexing that pixel", () => {
    const g = UTM_SYNTH, og = overlayGrid(g);
    for (const w of blockOf(g)) {
      const o = overlayIndex(w, g, og);
      const [kx, ky] = og.k.get(key(w))!;
      const cx = kx * og.px, cy = ky * og.py;
      const [tl] = o.corners as [number, number][];
      const u0 = Math.round(mercX(tl![0]) / cx), t1 = Math.round(mercY(tl![1]) / cy);
      expect(Math.abs(mercX(tl![0]) / cx - u0)).toBeLessThan(1e-6);
      expect(Math.abs(mercY(tl![1]) / cy - t1)).toBeLessThan(1e-6);
      let found = 0;
      for (let v = -20; v < o.height + 20; v++) for (let u = -20; u < o.width + 20; u++) {
        const [c, r] = invertAffine(g.gt, ...fromLonLat(g.epsg, lonOf((u0 + u + 0.5) * cx), latOf((t1 - v - 0.5) * cy))).map(Math.floor) as [number, number];
        if (c < w.x0 || c >= w.x0 + w.width || r < w.y0 || r >= w.y0 + w.height) continue;
        found++;
        expect(u >= 0 && v >= 0 && u < o.width && v < o.height, `cell (${u}, ${v}) of tile ${key(w)}`).toBe(true);
        const i = v * o.width + u;
        expect(bit(o.valid, i)).toBe(1);
        expect(o.index[i]).toBe((r - w.y0) * w.width + (c - w.x0));
      }
      expect(found).toBeGreaterThan(200 * 200);
    }
  });
});

describe("precision (spec 011 criterion 3, brute force over every pixel)", () => {
  for (const [name, g] of [...GRIDS, ...MORE]) {
    it(`every pixel within MAX_LAT holds a valid cell centre of its own tile indexing it; px, py within 2% of the minimum: ${name}`, () => {
      const og = overlayGrid(g);
      // brute-force minimum widths over every pixel wholly within MAX_LAT
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
      for (const w of tileWindows(g.width, g.height)) {
        const o = overlayIndex(w, g, og);
        const [tl, , br] = o.corners as [number, number][];
        const cx = (mercX(br![0]) - mercX(tl![0])) / o.width, cy = (mercY(tl![1]) - mercY(br![1])) / o.height;
        for (let v = 0; v < o.height; v++) for (let u = 0; u < o.width; u++) {
          const i = v * o.width + u;
          if (!bit(o.valid, i)) continue;
          const [c, r] = invertAffine(g.gt, ...fromLonLat(g.epsg, lonOf(mercX(tl![0]) + (u + 0.5) * cx), latOf(mercY(tl![1]) - (v + 0.5) * cy))).map(Math.floor) as [number, number];
          if (c < w.x0 || c >= w.x0 + w.width || r < w.y0 || r >= w.y0 + w.height) continue; // an extra cell
          if (o.index[i] === (r - w.y0) * w.width + (c - w.x0)) hit[r * g.width + c] = 1;
        }
      }
      const missed: string[] = [];
      for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
        if (!hit[r * g.width + c] && within(g, c, r)) missed.push(`${c},${r}`);
      }
      expect(missed.slice(0, 5), `${missed.length} pixels missed`).toEqual([]);
    }, 120_000);
  }
});

describe("no gaps where k steps (spec 011 criterion 4)", () => {
  it("the 60-85N grid has a ky step; blocks straddling it leave no gaps and overlap only within one coarse cell", () => {
    const g = STEP, og = overlayGrid(g);
    const ky = (y0: number) => og.k.get(`0,${y0}`)![1];
    const steps: number[] = [];
    for (let y0 = TILE_SIZE; y0 < g.height - TILE_SIZE; y0 += TILE_SIZE) if (ky(y0) !== ky(y0 - TILE_SIZE)) steps.push(y0);
    expect(steps.length).toBeGreaterThan(0);
    for (const seam of steps.slice(0, 3)) {
      const ws = blockOf(g, 0, seam - TILE_SIZE);
      const ovs = overlays(g, og, ws);
      const coarse = Math.max(ky(seam), ky(seam - TILE_SIZE)) * og.py;
      const seamY = mercY(lonLatOf(g, 0, seam)[1]);
      const rand = rng(seam);
      const bad: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const c = 2 + rand() * 508, r = seam - TILE_SIZE + 2 + rand() * 508;
        const [lon, lat] = lonLatOf(g, c, r);
        const n = ovs.filter((o) => covers(o, lon, lat)).length;
        if (n === 0 || (n > 1 && Math.abs(mercY(lat) - seamY) > coarse) || n > 2) bad.push(`(${c.toFixed(2)}, ${r.toFixed(2)}): ${n}`);
      }
      expect(bad.slice(0, 5), `seam row ${seam}: ${bad.length} points`).toEqual([]);
    }
  });
});

describe("overlay size (spec 011 criterion 5)", () => {
  const pow2 = (k: number) => Number.isInteger(Math.log2(k));
  for (const [name, g] of [...GRIDS, ...MORE]) {
    it(`powers of two, at most ceil(bbox side / (k p)) + 2, and matching lengths: ${name}`, () => {
      const og = overlayGrid(g);
      for (const w of tileWindows(g.width, g.height)) {
        const [kx, ky] = og.k.get(key(w))!;
        expect(pow2(kx) && pow2(ky), `${kx}, ${ky}`).toBe(true);
        const o = overlayIndex(w, g, og);
        const [x0, y0, x1, y1] = mercBounds(w, g.gt, g.epsg);
        expect(o.width).toBeLessThanOrEqual(Math.ceil((x1 - x0) / (kx * og.px)) + 2);
        expect(o.height).toBeLessThanOrEqual(Math.ceil((y1 - y0) / (ky * og.py)) + 2);
        if (GRIDS.some(([, h]) => h === g)) expect(Math.max(o.width, o.height)).toBeLessThanOrEqual(300);
        expect(o.index).toBeInstanceOf(Uint16Array);
        expect(o.index.length).toBe(o.width * o.height);
        expect(o.valid.length).toBe(Math.ceil((o.width * o.height) / 8));
      }
    }, 60_000);
  }
});
