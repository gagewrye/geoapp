import { afterEach, describe, expect, it, vi } from "vitest";
import * as crs from "../../../src/core/crs";
import { applyAffine, toLonLat } from "../../../src/core/crs";
import { latticeQuads, type Quad } from "../../../src/core/labelQuads";
import { MAX_LAT, type Grid } from "../../../src/core/types";

// Tester, spec 029 criterion 1: a tile straddling a real projection's edge, NaN holes at cell centres only,
// and a diagonal NaN boundary, each against the exact algorithm (lattice step 1).
const R = 6378137, D2R = Math.PI / 180;
const merc = (lon: number, lat: number): [number, number] => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
const FULL = { x0: 0, y0: 0, width: 256, height: 256 };
const real = toLonLat;
const ok = (p: readonly number[]) => p.every(Number.isFinite);

/** No lost corner (finite where the exact projection is), and every finite pixel corner of a finite quad within 0.055 px. */
function check(qs: Quad[], project: (c: number, r: number) => [number, number]) {
  let worst = 0, checked = 0;
  for (const q of qs) {
    const { x0, y0, width, height } = q.window;
    const xy = [[x0, y0], [x0 + width, y0], [x0 + width, y0 + height], [x0, y0 + height]] as const;
    q.corners.forEach((p, k) => { if (ok(project(xy[k]![0], xy[k]![1]))) expect(ok(p)).toBe(true); });
    if (!ok(q.corners.flat())) continue;
    const [tl, tr, br, bl] = q.corners.map((p) => merc(p[0]!, p[1]!)) as [number, number][];
    for (let r = y0; r <= y0 + height; r++) for (let c = x0; c <= x0 + width; c++) {
      const ll = project(c, r);
      const m = merc(...ll), p = merc(...project(c + 1, r)), s = merc(...project(c, r + 1));
      if (!ok([...m, ...p, ...s]) || Math.abs(ll[1]) > MAX_LAT) continue;
      const u = (c - x0) / width, v = (r - y0) / height;
      const bi = (k: 0 | 1) => (1 - u) * (1 - v) * tl![k] + u * (1 - v) * tr![k] + u * v * br![k] + (1 - u) * v * bl![k];
      const ax = p[0] - m[0], ay = p[1] - m[1], bx = s[0] - m[0], by = s[1] - m[1];
      const narrow = Math.abs(ax * by - ay * bx) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
      worst = Math.max(worst, Math.hypot(bi(0) - m[0], bi(1) - m[1]) / narrow);
      checked++;
    }
  }
  expect(worst).toBeLessThanOrEqual(0.055);
  return checked;
}

const realRef = crs.toLonLat;
afterEach(() => { vi.restoreAllMocks(); });

describe("non-finite lattice points (tester, spec 029 criterion 1)", () => {
  it("EPSG:32618 tile straddling where proj4 stops inverting (x = 1.72e7): no lost corners, accurate, far fewer projections than exact", () => {
    const g: Grid = { epsg: 32618, gt: [1.7e7, 1000, 0, 5e6, 0, -1000], width: 256, height: 256 };
    const project = (c: number, r: number) => real(g.epsg, ...applyAffine(g.gt, c, r));
    expect(ok(project(0, 0)) && !ok(project(256, 0))).toBe(true); // it does straddle
    const spy = vi.spyOn(crs, "toLonLat");
    const { quads, lattice } = latticeQuads(g, FULL, 0.05, 16);
    const n = spy.mock.calls.length;
    spy.mockRestore();
    expect(lattice).toBe(16);
    expect(n).toBeLessThan(66564 / 4);
    // like the exact algorithm, the band search keeps one quad with NaN corners here, so nothing of the finite part is placed
    check(quads, project);
    const exact = latticeQuads(g, FULL, 0.05, 1).quads;
    expect(quads.length === exact.length || quads.length === 2 * exact.length).toBe(true);
  });

  it("NaN only at isolated cell centres (holes): the lattice stays at 16 and nothing finite is lost", () => {
    const g: Grid = { epsg: 32633, gt: [500000, 30, 0, 5e6, 0, -30], width: 256, height: 256 };
    const hole = (c: number, r: number) => c % 16 === 8 && r % 16 === 8;
    const project = (c: number, r: number): [number, number] => (hole(c, r) ? [NaN, NaN] : realRef(32633, ...applyAffine(g.gt, c, r)));
    vi.spyOn(crs, "toLonLat").mockImplementation((_e, x, y) => project((x - 500000) / 30, (5e6 - y) / 30));
    const spy = vi.mocked(crs.toLonLat);
    const { quads, lattice } = latticeQuads(g, FULL, 0.05, 16);
    expect(lattice).toBe(16);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(600);
    vi.restoreAllMocks();
    check(quads, project);
  });

  it("a diagonal NaN boundary through the tile: same NaN corners as the exact algorithm, finite corners accurate", () => {
    const g: Grid = { epsg: 32633, gt: [500000, 30, 0, 5e6, 0, -30], width: 256, height: 256 };
    const project = (c: number, r: number): [number, number] => (c + 0.7 * r > 200 ? [NaN, NaN] : realRef(32633, ...applyAffine(g.gt, c, r)));
    vi.spyOn(crs, "toLonLat").mockImplementation((_e, x, y) => project((x - 500000) / 30, (5e6 - y) / 30));
    const { quads } = latticeQuads(g, FULL, 0.05, 16);
    const exact = latticeQuads(g, FULL, 0.05, 1).quads;
    vi.restoreAllMocks();
    check(quads, project);
    expect(quads.length === exact.length || quads.length === 2 * exact.length).toBe(true);
  });
});
