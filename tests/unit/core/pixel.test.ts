import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/crs-points.json";
import { applyAffine, fromLonLat, toLonLat } from "../../../src/core/crs";
import { BRUSH_MAX, BRUSH_MIN, BRUSH_STEP, DEFAULT_BRUSH, footprint, footprintRing, pixelAt, stepBrush, strokeCells, strokeCellsIn } from "../../../src/core/pixel";
import type { Affine, Grid } from "../../../src/core/types";

const grid = (epsg: number, gt: Affine, width = 1000, height = 1000): Grid => ({ epsg, gt, width, height });

describe("pixelAt (criterion 1)", () => {
  for (const c of fixture.cases) {
    it(`gives the floor of the reference pixel for EPSG:${c.epsg}`, () => {
      const g = grid(c.epsg, c.gt as Affine);
      const nearEdge = (v: number) => Math.abs(v - Math.round(v)) < 0.01;
      for (const p of c.points) {
        const [x, y] = p.pixel as [number, number];
        if (nearEdge(x) || nearEdge(y)) continue; // floor is undecidable within the reference's precision
        expect(pixelAt(g, p.lonlat[0]!, p.lonlat[1]!)).toEqual([Math.floor(x), Math.floor(y)]);
      }
    });
  }

  it("floors EPSG:4326 pixel centres (the fixture's 4326 points all lie on edges)", () => {
    const g = grid(4326, [10, 0.001, 0, 46, 0, -0.001]);
    expect(pixelAt(g, 10.5005, 45.7495)).toEqual([500, 250]);
    expect(pixelAt(g, 9.2495, 46.5005)).toEqual([-751, -501]);
    expect(pixelAt(g, 10.5005 + 360, 45.7495)).toEqual([500, 250]);
    expect(pixelAt(g, 10.5005 - 720, 45.7495)).toEqual([500, 250]);
  });

  it("gives the same pixel for lon +- 360", () => {
    for (const c of fixture.cases) {
      const g = grid(c.epsg, c.gt as Affine);
      for (const p of c.points) {
        if (p.pixel.some((v) => Math.abs(v - Math.round(v)) < 0.01)) continue; // edge points, as above
        const [lon, lat] = p.lonlat as [number, number];
        const at = pixelAt(g, lon, lat);
        expect(pixelAt(g, lon + 360, lat)).toEqual(at);
        expect(pixelAt(g, lon - 360, lat)).toEqual(at);
      }
    }
  });

  it("gives one pixel for lon 180.2 and -179.8 on an EPSG:32660 raster straddling 180", () => {
    // zone 60's central meridian is 177E; 30 m pixels from 176E to beyond 180
    const [x0, y0] = fromLonLat(32660, 176, 10);
    const g = grid(32660, [x0, 30, 0, y0, 0, -30], 20000, 100);
    expect(toLonLat(32660, ...applyAffine(g.gt, g.width, 0))[0]).toBeGreaterThan(180.2);
    const a = pixelAt(g, 180.2, 9.99);
    expect(a).toEqual(pixelAt(g, -179.8, 9.99));
    expect(a[0]).toBeGreaterThan(0);
    expect(a[0]).toBeLessThan(g.width);
  });

  it("may return a pixel off the raster", () => {
    const g = grid(4326, [10, 0.01, 0, 50, 0, -0.01], 100, 100);
    expect(pixelAt(g, 9.995, 50.005)).toEqual([-1, -1]);
    expect(pixelAt(g, 11.005, 49.005)).toEqual([100, 99]);
  });

  it("throws on an unsupported EPSG", () => {
    expect(() => pixelAt(grid(2154, [0, 1, 0, 0, 0, -1]), 2, 46)).toThrow(/EPSG:2154/);
    expect(() => pixelAt(grid(32661, [0, 1, 0, 0, 0, -1]), 2, 46)).toThrow(/unsupported/i);
  });
});

describe("footprint (criterion 2)", () => {
  const dims = { width: 100, height: 80 };
  it("is a centred size x size square for sizes 1, 3 and 7", () => {
    for (const s of [1, 3, 7]) {
      const h = (s - 1) / 2;
      expect(footprint(dims, 50, 40, s)).toEqual({ x0: 50 - h, y0: 40 - h, width: s, height: s });
    }
  });
  it("is clipped at raster edges", () => {
    expect(footprint(dims, 0, 0, 7)).toEqual({ x0: 0, y0: 0, width: 4, height: 4 });
    expect(footprint(dims, 99, 79, 7)).toEqual({ x0: 96, y0: 76, width: 4, height: 4 });
    expect(footprint(dims, -2, 40, 7)).toEqual({ x0: 0, y0: 37, width: 2, height: 7 });
    expect(footprint(dims, 102, 81, 7)).toEqual({ x0: 99, y0: 78, width: 1, height: 2 });
  });
  it("is null when the square misses the raster", () => {
    expect(footprint(dims, -4, 40, 7)).toBeNull();
    expect(footprint(dims, 50, 83, 7)).toBeNull();
    expect(footprint(dims, 100, 0, 1)).toBeNull();
    expect(footprint(dims, -1, -1, 1)).toBeNull();
  });
});

describe("stepBrush (spec 017 criterion 1)", () => {
  it("keeps the 1..127 odd range with the default 7", () => {
    expect([BRUSH_MIN, BRUSH_MAX, BRUSH_STEP, DEFAULT_BRUSH]).toEqual([1, 127, 2, 7]);
  });
  it("steps up to 2s + 1, capped at 127", () => {
    for (const [s, want] of [[1, 3], [3, 7], [7, 15], [9, 19], [63, 127], [99, 127], [127, 127]]) expect(stepBrush(s!, 1)).toBe(want);
  });
  it("steps down to 2·floor((s - 1) / 4) + 1, floored at 1", () => {
    for (const [s, want] of [[127, 63], [9, 5], [7, 3], [5, 3], [3, 1], [1, 1]]) expect(stepBrush(s!, -1)).toBe(want);
  });
  it("gives an odd size in 1..127 from every odd size", () => {
    for (let s = 1; s <= 127; s += 2) for (const d of [1, -1] as const) {
      const n = stepBrush(s, d);
      expect(n % 2).toBe(1);
      expect(n >= 1 && n <= 127).toBe(true);
    }
  });
});

describe("footprintRing", () => {
  it("gives TL, TR, BR, BL, TL of the window's outer pixel edges in lon/lat", () => {
    const g = grid(4326, [10, 0.01, 0, 50, 0, -0.01]);
    const ring = footprintRing(g, { x0: 2, y0: 3, width: 4, height: 5 });
    const want = [[10.02, 49.97], [10.06, 49.97], [10.06, 49.92], [10.02, 49.92], [10.02, 49.97]];
    expect(ring).toHaveLength(5);
    ring.forEach(([lon, lat], i) => {
      expect(lon).toBeCloseTo(want[i]![0]!, 12);
      expect(lat).toBeCloseTo(want[i]![1]!, 12);
    });
  });
  it("uses toLonLat for projected grids", () => {
    const gt: Affine = [500000, 30, 0, 5000000, 0, -30];
    const ring = footprintRing(grid(32633, gt), { x0: 10, y0: 20, width: 7, height: 7 });
    expect(ring[2]).toEqual(toLonLat(32633, 500000 + 17 * 30, 5000000 - 27 * 30));
  });
});

describe("strokeCells (criterion 3)", () => {
  const cases: [[number, number], [number, number]][] = [
    [[0, 0], [0, 0]], [[0, 0], [5, 0]], [[0, 0], [0, -4]], [[3, 4], [-7, 9]], [[-2, -3], [8, 17]],
    [[10, 10], [3, 1]], [[0, 0], [6, 6]], [[5, 2], [4, 30]], [[100, -50], [-100, 50]],
  ];
  for (const [a, b] of cases) {
    it(`${a} -> ${b}: both ends, 8-connected, max(|dc|, |dr|) + 1 cells`, () => {
      const cells = strokeCells(a, b);
      expect(cells[0]).toEqual(a);
      expect(cells.at(-1)).toEqual(b);
      expect(cells).toHaveLength(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) + 1);
      for (let i = 1; i < cells.length; i++) {
        const [c0, r0] = cells[i - 1]!, [c1, r1] = cells[i]!;
        expect(Math.abs(c1 - c0)).toBeLessThanOrEqual(1);
        expect(Math.abs(r1 - r0)).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe("strokeCellsIn", () => {
  it("gives exactly strokeCells' cells inside the box, in order", () => {
    let s = 9;
    const rnd = (n: number) => Math.floor(((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n) - n / 2;
    for (let t = 0; t < 400; t++) {
      const a: [number, number] = [rnd(200), rnd(200)], b: [number, number] = [rnd(200), rnd(200)];
      const box = { x0: rnd(100), y0: rnd(100), x1: 0, y1: 0 };
      box.x1 = box.x0 + Math.abs(rnd(120)); box.y1 = box.y0 + Math.abs(rnd(120));
      const want = strokeCells(a, b).filter(([c, r]) => c >= box.x0 && c <= box.x1 && r >= box.y0 && r <= box.y1);
      expect(strokeCellsIn(a, b, box), `${a} ${b} ${JSON.stringify(box)}`).toEqual(want);
    }
  });
  it("skips a long stroke's cells outside the box without visiting them", () => {
    const t0 = performance.now();
    const cells = strokeCellsIn([-3e8, -3e8 + 7], [3e8, 3e8 + 7], { x0: 0, y0: 0, x1: 999, y1: 999 });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells).toHaveLength(993); // rows 7..999 on the diagonal
  });
});
