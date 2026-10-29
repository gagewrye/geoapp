import { describe, expect, it } from "vitest";
import { applyAffine, fromLonLat, toLonLat } from "../../../src/core/crs";
import { tileWindows } from "../../../src/core/grid";
import { overlayIndex, overlayPitch, paintOverlay } from "../../../src/core/overlay";
import { TILE_SIZE, type Affine, type Grid } from "../../../src/core/types";

// Tester edge cases for spec 011: every tile of a raster (partial edge tiles included), not only a 2x2 block.
const R = 6378137, D2R = Math.PI / 180;
const mercX = (lon: number) => R * lon * D2R;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));

const UTM_FIXTURE: Grid = { epsg: 32633, gt: [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30], width: 600, height: 520 };
const UTM_SYNTH: Grid = (() => {
  const [x, y] = fromLonLat(32633, 18, 60);
  return { epsg: 32633, gt: [Math.round(x), 10, 0, Math.round(y), 0, -10] as Affine, width: 512, height: 512 };
})();
const GEO_45: Grid = { epsg: 4326, gt: [10, 0.0001, 0, 45.03, 0, -0.0001], width: 512, height: 512 };
// the criterion 1 grids, enlarged to partial edge tiles
const PARTIAL: [string, Grid][] = [
  ["spec 003 EPSG:32633 fixture (600x520, partial right column and bottom row)", UTM_FIXTURE],
  ["synthetic EPSG:32633 at 60N, 700x650", { ...UTM_SYNTH, width: 700, height: 650 }],
  ["EPSG:4326 at 45N, 530x300", { ...GEO_45, width: 530, height: 300 }],
  ["one-pixel raster", { ...UTM_SYNTH, width: 1, height: 1 }],
  ["EPSG:32733 (southern UTM) 3 deg off the meridian, 600x600", (() => {
    const [x, y] = fromLonLat(32733, 18, -40);
    return { epsg: 32733, gt: [Math.round(x), 10, 0, Math.round(y), 0, -10] as Affine, width: 600, height: 600 };
  })()],
];

function overlays(g: Grid) {
  const pitch = overlayPitch(g);
  return tileWindows(g.width, g.height).map((w) => {
    const o = overlayIndex(w, g, pitch);
    const rgba = new Uint8ClampedArray(o.width * o.height * 4);
    paintOverlay(o.index, new Uint8Array(w.width * w.height).fill(1), ["#ff0000"], rgba);
    return { ...o, rgba, w };
  });
}
type Ov = ReturnType<typeof overlays>[number];
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

describe("spec 011 on whole rasters with partial edge tiles (tester)", () => {
  for (const [name, g] of PARTIAL) {
    it(`partition: exactly one overlay covers each interior point, ${name}`, () => {
      const ovs = overlays(g);
      const rand = rng(7);
      const m = Math.min(2, (g.width - 1) / 2);
      const bad: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const c = g.width < 5 ? 0.25 + rand() * 0.5 : m + rand() * (g.width - 2 * m), r = g.height < 5 ? 0.25 + rand() * 0.5 : m + rand() * (g.height - 2 * m);
        const [lon, lat] = toLonLat(g.epsg, ...applyAffine(g.gt, c, r));
        const n = ovs.filter((o) => covers(o, lon, lat)).length;
        if (n !== 1) bad.push(`(${c.toFixed(2)}, ${r.toFixed(2)}): ${n}`);
      }
      expect(bad.slice(0, 5), `${bad.length} points`).toEqual([]);
    });

    it(`size: every tile's overlay is at most TILE_SIZE + 2 a side and on one pitch, ${name}`, () => {
      const pitch = overlayPitch(g);
      for (const o of overlays(g)) {
        expect(Math.max(o.width, o.height), `tile ${o.w.x0},${o.w.y0}`).toBeLessThanOrEqual(TILE_SIZE + 2);
        expect(o.index.length).toBe(o.width * o.height);
        const [tl, , br] = o.corners;
        expect((mercX(br![0]) - mercX(tl![0])) / o.width).toBeCloseTo(pitch, 6);
        // every index is inside the tile
        for (const k of o.index) expect(k < o.w.width * o.w.height).toBe(true);
      }
    });
  }
});

describe("overlay size outside criterion 1's grids (tester finding)", () => {
  // A southern-hemisphere EPSG:4326 raster with a partial last row has its tallest-in-Mercator full row in
  // the middle, which no corner tile measures; ADR 0016's every-tile pitch covers it (spec 011 criterion 4).
  it("a coarse southern EPSG:4326 raster with a partial last row keeps every overlay within TILE_SIZE + 2", () => {
    const g: Grid = { epsg: 4326, gt: [10, 0.01, 0, -45, 0, -0.01], width: 300, height: 520 };
    const pitch = overlayPitch(g);
    const sides = tileWindows(g.width, g.height).map((w) => {
      const o = overlayIndex(w, g, pitch);
      return { key: `${w.x0},${w.y0}`, h: o.height, w: o.width };
    });
    const worst = Math.max(...sides.map((s) => Math.max(s.w, s.h)));
    expect(worst, JSON.stringify(sides)).toBeLessThanOrEqual(TILE_SIZE + 2);
  });
});
