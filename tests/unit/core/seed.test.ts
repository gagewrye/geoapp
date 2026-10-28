import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { applyLut, gatherCells, markValues, maskNodata, mergeTile, seedLut, seedWindows, sourceCells } from "../../../src/core/seed";
import type { Affine, Grid, Tile } from "../../../src/core/types";

// Spec 004 criteria 1 (sourceCells), 2 (seedWindows), 4 (seedLut, applyLut), 6 (mergeTile) and 7 (maskNodata).

const points = JSON.parse(readFileSync("tests/fixtures/crs-points.json", "utf8")) as
  { cases: { epsg: number; gt: Affine; points: { lonlat: [number, number]; pixel: [number, number] }[] }[] };

describe("sourceCells (criterion 1)", () => {
  it("maps every pixel to itself on equal grids", () => {
    for (const grid of [{ width: 600, height: 300, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] }, { width: 300, height: 270, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }] as Grid[]) {
      for (const w of tileWindows(grid.width, grid.height)) {
        const cells = sourceCells(grid, grid, w);
        expect(cells).toHaveLength(2 * w.width * w.height);
        let bad = 0;
        for (let i = 0; i < w.width * w.height; i++) {
          if (cells[2 * i] !== w.x0 + (i % w.width) || cells[2 * i + 1] !== w.y0 + Math.floor(i / w.width)) bad++;
        }
        expect(bad).toBe(0);
      }
    }
  });

  it("gives the floor of the recorded EPSG:32633 pixel for EPSG:4326 pixel centres at the crs-points", () => {
    const utm = points.cases.find((c) => c.epsg === 32633)!;
    const src: Grid = { width: 20000, height: 200000, epsg: 32633, gt: utm.gt };
    let checked = 0;
    for (const { lonlat: [lon, lat], pixel } of utm.points) {
      if (pixel.some((p) => Math.abs(p - Math.round(p)) < 0.01)) continue;
      // a 3x3 EPSG:4326 grid whose centre pixel's centre is the point
      const d = 1e-4;
      const dst: Grid = { width: 3, height: 3, epsg: 4326, gt: [lon - 1.5 * d, d, 0, lat + 1.5 * d, 0, -d] };
      const cells = sourceCells(dst, src, { x0: 1, y0: 1, width: 1, height: 1 });
      expect([cells[0], cells[1]]).toEqual(pixel.map(Math.floor));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("gives -1, -1 for pixels whose centre is off src", () => {
    const src: Grid = { width: 10, height: 10, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
    const dst: Grid = { width: 20, height: 20, epsg: 32633, gt: [499850, 30, 0, 5000150, 0, -30] }; // src starts at dst (5, 5)
    const cells = sourceCells(dst, src, { x0: 0, y0: 0, width: 20, height: 20 });
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
      const i = r * 20 + c;
      const on = c >= 5 && c < 15 && r >= 5 && r < 15;
      expect([cells[2 * i], cells[2 * i + 1]]).toEqual(on ? [c - 5, r - 5] : [-1, -1]);
    }
  });
});

describe("seedWindows (criterion 2)", () => {
  // a 3x3-window EPSG:4326 dst over 15E 45N (EPSG:32633's central meridian)
  const dst: Grid = { width: 700, height: 600, epsg: 4326, gt: [14.9, 0.0005, 0, 45.1, 0, -0.0005] };
  const holds = (src: Grid) => tileWindows(dst.width, dst.height).filter((w) => sourceCells(dst, src, w).some((v) => v >= 0));
  const keys = (ws: { x0: number; y0: number }[]) => ws.map((w) => `${w.x0},${w.y0}`);

  it("holds every window with a cell on a src in another CRS, row-major", { timeout: 30_000 }, () => {
    const srcs: Grid[] = [
      { width: 40, height: 30, epsg: 32633, gt: [500500, 10, 0, 4990000, 0, -10] }, // inside one window
      { width: 3, height: 3, epsg: 32633, gt: [492500, 7, 0, 4993000, 0, -7] }, // tiny, near the north-west corner
      { width: 500, height: 400, epsg: 32633, gt: [495000, 20, 0, 4996000, 0, -20] }, // across window edges and off the north edge
      { width: 1, height: 1, epsg: 32633, gt: [505000, 20000, 0, 4985000, 0, -20000] }, // one pixel wider than a window
      { width: 100, height: 100, epsg: 3857, gt: [1670000, 5, 0, 5620000, 0, -5] }, // EPSG:3857
    ];
    for (const src of srcs) {
      const got = seedWindows(dst, src);
      const want = holds(src);
      expect(want.length).toBeGreaterThan(0);
      expect(keys(got)).toEqual(expect.arrayContaining(keys(want)));
      expect(got).toEqual(tileWindows(dst.width, dst.height).filter((w) => got.some((g) => g.x0 === w.x0 && g.y0 === w.y0)));
    }
  });

  it("gives [] for a disjoint src", () => {
    expect(seedWindows(dst, { width: 100, height: 100, epsg: 32633, gt: [600000, 30, 0, 4800000, 0, -30] })).toEqual([]);
    expect(seedWindows(dst, { width: 100, height: 100, epsg: 4326, gt: [-60, 0.01, 0, 10, 0, -0.01] })).toEqual([]);
  });
});

describe("gatherCells and markValues", () => {
  it("copies the values of cells inside the src window and leaves the rest", () => {
    // cells: (0,0), (3,1), (-1,-1), (2,1), (5,5)
    const cells = Int32Array.from([0, 0, 3, 1, -1, -1, 2, 1, 5, 5]);
    const out = new Int16Array(5).fill(-1);
    // window cols 2..3, rows 0..1
    gatherCells(cells, { x0: 2, y0: 0, width: 2, height: 2 }, Uint8Array.from([10, 11, 12, 13]), out);
    expect([...out]).toEqual([-1, 13, -1, 12, -1]);
    gatherCells(cells, { x0: 0, y0: 0, width: 2, height: 1 }, Uint8Array.from([255, 1]), out);
    expect([...out]).toEqual([255, 13, -1, 12, -1]);
    const seen = new Uint8Array(256);
    markValues(out, seen);
    expect([...seen.keys()].filter((v) => seen[v])).toEqual([12, 13, 255]);
  });
});

describe("seedLut and applyLut (criterion 4)", () => {
  const entries = [{ value: 0, name: "Class 0" }, { value: 3, name: "Class 3" }, { value: 7, name: "Class 7" }];
  it("maps listed values to their label values and everything else to 0", () => {
    for (const values of [[1, 2, 3], [5, 1, 9]]) {
      const lut = seedLut(entries, values);
      expect(lut).toHaveLength(256);
      for (let v = 0; v < 256; v++) expect(lut[v]).toBe(v === 0 ? values[0] : v === 3 ? values[1] : v === 7 ? values[2] : 0);
    }
  });
  it("applyLut maps -1 to 0", () => {
    const lut = seedLut(entries, [5, 1, 9]);
    expect([...applyLut(Int16Array.from([-1, 0, 3, 7, 255, 4]), lut)]).toEqual([0, 5, 1, 9, 0, 0]);
  });
});

describe("mergeTile (criterion 6)", () => {
  it("keeps every non-zero old pixel and takes the seed elsewhere; undefined old gives the seed", () => {
    const old = Uint8Array.from([0, 2, 0, 3, 1]);
    const seed = Uint8Array.from([4, 4, 0, 0, 5]);
    expect([...mergeTile(old, seed)]).toEqual([4, 2, 0, 3, 1]);
    expect([...old]).toEqual([0, 2, 0, 3, 1]);
    expect([...mergeTile(undefined, seed)]).toEqual([4, 4, 0, 0, 5]);
  });
});

describe("maskNodata (criterion 7)", () => {
  // 4x2: pixel 1 is nodata (-9) in band 2 only; pixel 5 is NaN in band 3 (Float32)
  const tile = (nodata: number | null): Tile => ({ x0: 0, y0: 0, width: 4, height: 2, nodata, bands: [
    Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]), Float32Array.from([1, -9, 3, 4, 5, 6, 7, 8]), Float32Array.from([1, 2, 3, 4, 5, NaN, 7, 8]),
  ] });
  it("clears pixels equal to nodata in any band and NaN pixels; with nodata null only NaN", () => {
    const a = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 0]);
    maskNodata(tile(-9), a);
    expect([...a]).toEqual([1, 0, 3, 4, 5, 0, 7, 0]);
    const b = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 0]);
    maskNodata(tile(null), b);
    expect([...b]).toEqual([1, 2, 3, 4, 5, 0, 7, 0]);
  });
});
