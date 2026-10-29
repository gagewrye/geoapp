import { describe, expect, it } from "vitest";
import { classesFromValues } from "../../../src/core/classTable";
import { applyAffine, fromLonLat, invertAffine, normalizeLon, toLonLat } from "../../../src/core/crs";
import { tileWindows, type Window } from "../../../src/core/grid";
import { applyLut, gatherCells, markValues, maskNodata, seedLut, seedWindows, sourceCells } from "../../../src/core/seed";
import type { Grid, Tile } from "../../../src/core/types";

// Tester edge cases for spec 004's core seeding: pixel-centre edges, partial windows, CRS pairs
// (180 included), rotated grids, and that merging never writes into the arrays it was given.

/** The spec's definition, written out: dst centre -> dst gt -> lon/lat -> src CRS -> inverse src gt -> floor. */
function refCell(dst: Grid, src: Grid, c: number, r: number): [number, number] {
  const [x, y] = applyAffine(dst.gt, c + 0.5, r + 0.5);
  let fc: number, fr: number;
  if (dst.epsg === src.epsg) [fc, fr] = invertAffine(src.gt, x, y);
  else {
    const [lon, lat] = toLonLat(dst.epsg, x, y);
    [fc, fr] = invertAffine(src.gt, ...fromLonLat(src.epsg, normalizeLon(lon), lat));
  }
  const col = Math.floor(fc), row = Math.floor(fr);
  return col >= 0 && col < src.width && row >= 0 && row < src.height ? [col, row] : [-1, -1];
}

function expectCells(dst: Grid, src: Grid, w: Window): number {
  const cells = sourceCells(dst, src, w);
  let bad = 0, on = 0;
  for (let i = 0; i < w.width * w.height; i++) {
    const [c, r] = refCell(dst, src, w.x0 + (i % w.width), w.y0 + Math.floor(i / w.width));
    if (cells[2 * i] !== c || cells[2 * i + 1] !== r) bad++;
    if (c >= 0) on++;
  }
  expect(bad).toBe(0);
  return on;
}

describe("sourceCells edges", () => {
  it("a centre exactly on src's left or top edge is on src (col/row 0); on its right or bottom edge it is off", () => {
    // dst 10 m pixels; src 20 m pixels whose edges fall exactly on dst centres
    const dst: Grid = { width: 12, height: 12, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
    const src: Grid = { width: 4, height: 4, epsg: 32633, gt: [500015, 20, 0, 4999985, 0, -20] }; // x edges 500015..500095
    const cells = sourceCells(dst, src, { x0: 0, y0: 0, width: 12, height: 12 });
    const at = (c: number, r: number) => [cells[2 * (r * 12 + c)], cells[2 * (r * 12 + c) + 1]];
    // dst col 1's centre is x = 500015 (src's left edge), col 9's is 500095 (src's right edge)
    expect(at(1, 1)).toEqual([0, 0]);
    expect(at(0, 1)).toEqual([-1, -1]);
    expect(at(8, 8)).toEqual([3, 3]);
    expect(at(9, 1)).toEqual([-1, -1]);
    expect(at(1, 9)).toEqual([-1, -1]);
    // inside, centres on an inner src edge go to the pixel to the right / below (floor)
    expect(at(3, 3)).toEqual([1, 1]);
  });

  it("partial edge windows of a dst that isn't a multiple of 256 match the definition, also for rotated and other-CRS srcs", () => {
    const dst: Grid = { width: 600, height: 500, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
    const srcs: Grid[] = [
      { width: 300, height: 260, epsg: 32633, gt: [508000, 45, 0, 4993000, 0, -45] }, // crosses dst's right and bottom edges
      { width: 200, height: 200, epsg: 32633, gt: [503000, 40, 10, 4996000, 8, -40] }, // rotated and sheared
      { width: 400, height: 300, epsg: 4326, gt: [15.05, 0.0006, 0, 45.12, 0, -0.0006] },
      { width: 300, height: 300, epsg: 3857, gt: [1675000, 50, 0, 5636000, 0, -50] },
    ];
    for (const src of srcs) {
      let on = 0;
      for (const w of tileWindows(dst.width, dst.height)) on += expectCells(dst, src, w);
      expect(on, JSON.stringify(src.gt)).toBeGreaterThan(1000);
    }
  });

  it("across 180: a UTM 60 dst straddling 180 takes cells from an EPSG:4326 src west of 180 and a UTM 1 src east of it", () => {
    // zone 60 x 700000..820000 at 50N spans about 179.8E to 181.4E
    const dst: Grid = { width: 400, height: 300, epsg: 32660, gt: [700000, 300, 0, 5560000, 0, -300] };
    const west: Grid = { width: 500, height: 400, epsg: 4326, gt: [179.0, 0.002, 0, 50.3, 0, -0.002] }; // 179..180E
    const east: Grid = { width: 300, height: 300, epsg: 32601, gt: [280000, 300, 0, 5560000, 0, -300] }; // east of 180
    for (const src of [west, east]) {
      let on = 0;
      for (const w of tileWindows(dst.width, dst.height)) on += expectCells(dst, src, w);
      expect(on).toBeGreaterThan(5000);
    }
  });
});

describe("seedWindows (brute force, more CRS pairs)", () => {
  const holds = (dst: Grid, src: Grid) => tileWindows(dst.width, dst.height).filter((w) => sourceCells(dst, src, w).some((v) => v >= 0)).map((w) => `${w.x0},${w.y0}`);
  const cases: [string, Grid, Grid][] = [
    ["UTM dst, 4326 src across a window corner", { width: 1000, height: 700, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] },
      { width: 20, height: 20, epsg: 4326, gt: [15.0966, 0.0001, 0, 45.0853, 0, -0.0001] }],
    ["UTM dst, one-pixel UTM 34 src", { width: 1000, height: 700, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] },
      { width: 1, height: 1, epsg: 32634, gt: [43250, 40, 0, 5004910, 0, -40] }],
    ["3857 dst, rotated UTM src", { width: 800, height: 800, epsg: 3857, gt: [1669792, 30, 0, 5621521, 0, -30] },
      { width: 300, height: 300, epsg: 32633, gt: [505000, 20, 15, 4985000, 15, -20] }],
    ["4326 dst near 180, UTM 60 src crossing 180", { width: 600, height: 600, epsg: 4326, gt: [179.0, 0.00166, 0, 50.5, 0, -0.00166] },
      { width: 400, height: 300, epsg: 32660, gt: [700000, 300, 0, 5560000, 0, -300] }],
    ["UTM 60 dst straddling 180, UTM 1 src", { width: 700, height: 600, epsg: 32660, gt: [700000, 200, 0, 5600000, 0, -200] },
      { width: 300, height: 300, epsg: 32601, gt: [280000, 300, 0, 5560000, 0, -300] }],
    ["south UTM dst, 4326 src", { width: 900, height: 600, epsg: 32733, gt: [300000, 30, 0, 7000000, 0, -30] },
      { width: 200, height: 200, epsg: 4326, gt: [13.15, 0.0005, 0, -27.05, 0, -0.0005] }],
  ];
  for (const [name, dst, src] of cases) {
    it(`holds every window with a cell (${name}), row-major and without repeats`, { timeout: 30_000 }, () => {
      const got = seedWindows(dst, src);
      const keys = got.map((w) => `${w.x0},${w.y0}`);
      const want = holds(dst, src);
      expect(want.length).toBeGreaterThan(0);
      for (const k of want) expect(keys, k).toContain(k);
      expect(new Set(keys).size).toBe(keys.length);
      const order = tileWindows(dst.width, dst.height).map((w) => `${w.x0},${w.y0}`);
      expect(keys).toEqual(order.filter((k) => keys.includes(k)));
      for (const w of got) expect(w).toEqual(tileWindows(dst.width, dst.height).find((t) => t.x0 === w.x0 && t.y0 === w.y0));
    });
  }
});

describe("gatherCells, markValues, classesFromValues, LUTs", () => {
  it("gathers from a clipped (partial) file window using its own width", () => {
    const sw: Window = { x0: 256, y0: 256, width: 44, height: 10 };
    const data = new Uint8Array(44 * 10).map((_, i) => i % 251);
    const cells = new Int32Array([256, 256, 299, 265, 300, 256, 255, 256, -1, -1, 270, 258]);
    const out = new Int16Array(6).fill(-1);
    gatherCells(cells, sw, data, out);
    expect([...out]).toEqual([data[0], data[9 * 44 + 43], -1, -1, -1, data[2 * 44 + 14]]);
  });

  it("markValues ignores -1 and marks 0 and 255; classesFromValues of nothing is [] and of all 256 values without nodata is 256 entries", () => {
    const seen = new Uint8Array(256);
    markValues(new Int16Array([-1, -1]), seen);
    expect(classesFromValues(seen, null)).toEqual([]);
    markValues(new Int16Array([0, 255, -1]), seen);
    expect(classesFromValues(seen, null).map((e) => e.value)).toEqual([0, 255]);
    expect(classesFromValues(seen, 0).map((e) => e.name)).toEqual(["Class 255"]);
    const all = new Uint8Array(256).fill(1);
    expect(classesFromValues(all, null)).toHaveLength(256);
    expect(classesFromValues(all, 17).map((e) => e.value)).not.toContain(17);
  });

  it("a single-class table maps its value only; applyLut of an empty array is empty", () => {
    const lut = seedLut([{ value: 9, name: "only" }], [4]);
    expect([...lut].filter((v) => v)).toEqual([4]);
    expect(lut[9]).toBe(4);
    expect(applyLut(new Int16Array(0), lut)).toHaveLength(0);
    expect([...applyLut(new Int16Array([9, -1, 0, 255]), lut)]).toEqual([4, 0, 0, 0]);
  });
});

describe("maskNodata edges", () => {
  const tile = (bands: number[][], nodata: number | null): Tile => ({ x0: 0, y0: 0, width: bands[0]?.length ?? 4, height: 1, nodata, bands: bands.map((b) => Float32Array.from(b)) });
  it("masks -Infinity nodata, NaN in any band, and -0 when nodata is 0", () => {
    const l = new Uint8Array([1, 2, 3, 4]);
    maskNodata(tile([[-Infinity, 1, 2, 3], [5, 5, NaN, 5]], -Infinity), l);
    expect([...l]).toEqual([0, 2, 0, 4]);
    const z = new Uint8Array([1, 2]);
    maskNodata(tile([[-0, 1]], 0), z);
    expect([...z]).toEqual([0, 2]);
  });
  it("throws on a label array of the wrong length", () => {
    expect(() => maskNodata(tile([[1, 2, 3, 4]], null), new Uint8Array(3))).toThrow();
  });
});
