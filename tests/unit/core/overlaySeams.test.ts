import { describe, expect, it } from "vitest";
import { applyAffine, fromLonLat, invertAffine, toLonLat } from "../../../src/core/crs";
import { tileWindow } from "../../../src/core/labelStore";
import { overlayIndex, overlayPitch, paintOverlay } from "../../../src/core/overlay";
import { TILE_SIZE, type Affine, type Grid } from "../../../src/core/types";
import type { Window } from "../../../src/core/grid";

// Spec 011: overlays of one raster share one Mercator pixel grid, so tiles partition the overlay pixels.
const R = 6378137, D2R = Math.PI / 180;
const mercX = (lon: number) => R * lon * D2R;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
const lonOf = (x: number) => x / R / D2R;
const latOf = (y: number) => Math.atan(Math.sinh(y / R)) / D2R;

/** Spec 003's EPSG:32633 fixture (tests/unit/core/overlay.test.ts). */
const UTM_FIXTURE: Grid = { epsg: 32633, gt: [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30], width: 600, height: 520 };
/** EPSG:32633, 3 degrees east of its central meridian (15E) at 60N, 10 m pixels. */
const UTM_SYNTH: Grid = (() => {
  const [x, y] = fromLonLat(32633, 18, 60);
  const gt: Affine = [Math.round(x), 10, 0, Math.round(y), 0, -10];
  return { epsg: 32633, gt, width: 512, height: 512 };
})();
const GEO_45: Grid = { epsg: 4326, gt: [10, 0.0001, 0, 45.03, 0, -0.0001], width: 512, height: 512 };
const GRIDS: [string, Grid][] = [["spec 003 EPSG:32633 fixture", UTM_FIXTURE], ["EPSG:32633 3 deg off the meridian at 60N", UTM_SYNTH], ["EPSG:4326 at 45N", GEO_45]];
const BLOCK = ["0,0", "256,0", "0,256", "256,256"];

type Ov = ReturnType<typeof overlayIndex> & { rgba: Uint8ClampedArray };

/** Overlays of the fully labelled 2x2 block. */
function block(g: Grid): Ov[] {
  const pitch = overlayPitch(g);
  return BLOCK.map((k) => {
    const [x0, y0] = k.split(",").map(Number) as [number, number];
    const w = tileWindow(g, x0, y0);
    const o = overlayIndex(w, g, pitch);
    const rgba = new Uint8ClampedArray(o.width * o.height * 4);
    paintOverlay(o.index, new Uint8Array(w.width * w.height).fill(1), ["#ff0000"], rgba);
    return { ...o, rgba };
  });
}

/** True when the overlay has an opaque pixel covering lon/lat, located from its corners, width and height. */
function covers(o: Ov, lon: number, lat: number): boolean {
  const [tl, , br] = o.corners as [number, number][];
  const u = Math.floor(((mercX(lon) - mercX(tl![0])) / (mercX(br![0]) - mercX(tl![0]))) * o.width);
  const v = Math.floor(((mercY(tl![1]) - mercY(lat)) / (mercY(tl![1]) - mercY(br![1]))) * o.height);
  return u >= 0 && v >= 0 && u < o.width && v < o.height && o.rgba[4 * (v * o.width + u) + 3] === 255;
}

/** Seeded uniform [0, 1) (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("overlay partition (spec 011 criterion 1, regression)", () => {
  for (const [name, g] of GRIDS) {
    it(`exactly one overlay covers each of 10,000 points: ${name}`, () => {
      const ovs = block(g);
      const rand = rng(11);
      const bad: string[] = [];
      for (let i = 0; i < 10_000; i++) {
        const c = 2 + rand() * 508, r = 2 + rand() * 508;
        const [lon, lat] = toLonLat(g.epsg, ...applyAffine(g.gt, c, r));
        const n = ovs.filter((o) => covers(o, lon, lat)).length;
        if (n !== 1) bad.push(`(${c.toFixed(2)}, ${r.toFixed(2)}): ${n}`);
      }
      expect(bad.slice(0, 5), `${bad.length} points`).toEqual([]);
    });
  }
});

describe("overlay completeness (spec 011 criterion 2, brute force)", () => {
  it("every pitch cell whose centre maps into tile w is in w's overlay, indexing that pixel", () => {
    const g = UTM_SYNTH;
    const pitch = overlayPitch(g);
    for (const k of BLOCK) {
      const [x0, y0] = k.split(",").map(Number) as [number, number];
      const w: Window = tileWindow(g, x0, y0);
      const o = overlayIndex(w, g, pitch);
      const [tl] = o.corners as [number, number][];
      const u0 = Math.round(mercX(tl![0]) / pitch), t1 = Math.round(mercY(tl![1]) / pitch);
      // the corners sit on the shared grid
      expect(Math.abs(mercX(tl![0]) / pitch - u0)).toBeLessThan(1e-6);
      expect(Math.abs(mercY(tl![1]) / pitch - t1)).toBeLessThan(1e-6);
      // search a margin of 20 cells around the overlay
      let found = 0;
      for (let v = -20; v < o.height + 20; v++) for (let u = -20; u < o.width + 20; u++) {
        const lon = lonOf((u0 + u + 0.5) * pitch), lat = latOf((t1 - v - 0.5) * pitch);
        const [c, r] = invertAffine(g.gt, ...fromLonLat(g.epsg, lon, lat)).map(Math.floor) as [number, number];
        const inside = c >= w.x0 && c < w.x0 + w.width && r >= w.y0 && r < w.y0 + w.height;
        const inOverlay = u >= 0 && v >= 0 && u < o.width && v < o.height;
        if (inside) {
          found++;
          expect(inOverlay, `cell (${u}, ${v}) of tile ${k}`).toBe(true);
          expect(o.index[v * o.width + u]).toBe((r - w.y0) * w.width + (c - w.x0));
        } else if (inOverlay) expect(o.index[v * o.width + u]).toBe(-1);
      }
      expect(found).toBeGreaterThan(200 * 200);
    }
  });
});

describe("overlay size and pitch (spec 011 criterion 4)", () => {
  for (const [name, g] of GRIDS) {
    it(`at most TILE_SIZE + 2 a side, every tile on the same pitch: ${name}`, () => {
      const pitch = overlayPitch(g);
      expect(pitch).toBeGreaterThan(0);
      expect(overlayPitch({ ...g })).toBe(pitch);
      for (const o of block(g)) {
        expect(o.width).toBeLessThanOrEqual(TILE_SIZE + 2);
        expect(o.height).toBeLessThanOrEqual(TILE_SIZE + 2);
        const [tl, , br] = o.corners as [number, number][];
        expect((mercX(br![0]) - mercX(tl![0])) / o.width).toBeCloseTo(pitch, 6);
        expect((mercY(tl![1]) - mercY(br![1])) / o.height).toBeCloseTo(pitch, 6);
      }
    });
  }
});
