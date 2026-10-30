import { afterEach, describe, expect, it, vi } from "vitest";
import * as crs from "../../../src/core/crs";
import { fromLonLat, invertAffine } from "../../../src/core/crs";
import { decimatedAffine } from "../../../src/core/decimate";
import { latticeEach, PREVIEW_CHECK, PREVIEW_EDGE, PREVIEW_LATTICE } from "../../../src/core/lattice";
import { cellBuckets, previewCells } from "../../../src/core/maskPreview";
import type { Affine, Grid } from "../../../src/core/types";
import { latOf, lonOf, mercatorGrid, mercBounds } from "../../../src/core/warp";

// Spec 030 criteria 1-3: preview sampling from a self-checked lattice, with every floor equal to the exact one.
const at = (epsg: number, lon: number, lat: number, px: number, size: number): Grid => {
  const [x, y] = fromLonLat(epsg, lon, lat);
  return { epsg, gt: [Math.round(x), px, 0, Math.round(y), 0, -px], width: size, height: size };
};
const geo = (lat: number, px: number, size: number): Grid => ({ epsg: 4326, gt: [10, px, 0, lat + (px * size) / 2, 0, -px], width: size, height: size });
const SPEC_003: Grid = { epsg: 32633, gt: [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30], width: 600, height: 520 };
/** The typical chunk: 6485 square, UTM 18N, 0.1 m. */
const TYPICAL = at(32618, -77.16, 17.83, 0.1, 6485);
const GRIDS: [string, Grid][] = [
  ["spec 003 EPSG:32633", SPEC_003],
  ["UTM 18N 0.1 m (typical chunk)", TYPICAL],
  ["EPSG:4326 at 0", geo(0, 0.001, 3000)],
  ["EPSG:4326 at 60", geo(60, 0.001, 3000)],
  ["EPSG:4326 at 84", geo(84, 0.001, 2000)],
  ["30 m UTM at 63 N", at(32633, 18, 63, 30, 4000)],
  ["30 m UTM at 63 N decimated by 4", (() => { const g = at(32633, 18, 63, 30, 4000); return { ...g, gt: decimatedAffine(g.gt, 4) as Affine, width: 1000, height: 1000 }; })()],
];

/** The exact preview sampling mercatorGrid's each did before spec 030: one projection per preview pixel. */
function exactEach(g: Grid, maxSide: number) {
  const win = { x0: 0, y0: 0, width: g.width, height: g.height };
  const [mx0, my0, mx1, my1] = mercBounds(win, g.gt, g.epsg);
  const { width, height } = mercatorGrid(win, g.gt, g.epsg, maxSide);
  const sx = (mx1 - mx0) / width, sy = (my1 - my0) / height;
  const cr = new Float64Array(2 * width * height);
  for (let v = 0; v < height; v++) {
    const lat = latOf(my1 - (v + 0.5) * sy);
    for (let u = 0; u < width; u++) {
      const [c, r] = invertAffine(g.gt, ...fromLonLat(g.epsg, lonOf(mx0 + (u + 0.5) * sx), lat));
      cr[2 * (v * width + u)] = c; cr[2 * (v * width + u) + 1] = r;
    }
  }
  return { width, height, cr };
}

/** Pixels whose floor(c) or floor(r) differs from the exact loop's (NaN counts as its own value). */
function floorMismatches(g: Grid, maxSide: number): number {
  const ref = exactEach(g, maxSide);
  const { each } = mercatorGrid({ x0: 0, y0: 0, width: g.width, height: g.height }, g.gt, g.epsg, maxSide);
  let bad = 0, seen = 0;
  const same = (a: number, b: number) => Object.is(Math.floor(a), Math.floor(b));
  each((o, c, r) => { seen++; if (!same(c, ref.cr[2 * o]!) || !same(r, ref.cr[2 * o + 1]!)) bad++; });
  expect(seen).toBe(ref.width * ref.height);
  return bad;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("preview lattice (spec 030)", () => {
  it("uses a 16 px lattice, a 0.001 px check and a 0.005 px edge margin", () => {
    expect([PREVIEW_LATTICE, PREVIEW_CHECK, PREVIEW_EDGE]).toEqual([16, 0.001, 0.005]);
  });

  it.each(GRIDS)("criterion 1: every pixel's floor(c) and floor(r) equal the exact loop's: %s", (_n, g) => {
    expect(floorMismatches(g, 512)).toBe(0);
  });

  it("criterion 1: at full preview size on the typical chunk too", () => {
    expect(floorMismatches(TYPICAL, 1024)).toBe(0);
  });

  it("criterion 1: points that don't project (NaN) are computed exactly, and the rest still match", () => {
    // a disc and a band of NaN, as where a projection gives up, over a smooth mapping
    const W = 700, H = 500;
    const exact = (u: number, v: number): [number, number] => {
      if ((u - 300) ** 2 + (v - 200) ** 2 < 90 ** 2 || (u > 610 && v < 130)) return [NaN, NaN];
      const x = (u + 0.5) * 1.37 + Math.sin(v / 90) * 3, y = (v + 0.5) * 0.91 + (u * u) / 4000;
      return [x, y];
    };
    let bad = 0, seen = 0;
    latticeEach(W, H, exact, (o, c, r) => {
      seen++;
      const [ec, er] = exact(o % W, Math.floor(o / W));
      if (!Object.is(Math.floor(c), Math.floor(ec)) || !Object.is(Math.floor(r), Math.floor(er))) bad++;
    });
    expect([seen, bad]).toEqual([W * H, 0]);
  });

  it("visits every pixel once, row-major", () => {
    const order: number[] = [];
    latticeEach(37, 21, (u, v) => [u * 1.5, v * 2.5], (o) => order.push(o));
    expect(order).toEqual(Array.from({ length: 37 * 21 }, (_, i) => i));
  });

  it("criterion 2: a 1024 px preview of the typical chunk calls fromLonLat at most 40,000 times", () => {
    const spy = vi.spyOn(crs, "fromLonLat");
    const { each } = mercatorGrid({ x0: 0, y0: 0, width: TYPICAL.width, height: TYPICAL.height }, TYPICAL.gt, TYPICAL.epsg, 1024);
    spy.mockClear();
    each(() => {});
    expect(spy.mock.calls.length).toBeLessThanOrEqual(40_000);
  });

  it("criterion 3: previewCells and cellBuckets are byte-equal to the exact loop", () => {
    for (const g of [TYPICAL, SPEC_003]) {
      const { cells, width, height } = previewCells(g, 1024);
      const ref = exactEach(g, 1024);
      expect([width, height]).toEqual([ref.width, ref.height]);
      const want = new Int32Array(2 * width * height);
      for (let o = 0; o < width * height; o++) {
        const i = Math.floor(ref.cr[2 * o]!), j = Math.floor(ref.cr[2 * o + 1]!);
        const on = i >= 0 && i < g.width && j >= 0 && j < g.height;
        want[2 * o] = on ? i : -1; want[2 * o + 1] = on ? j : -1;
      }
      expect(Buffer.from(cells.buffer).equals(Buffer.from(want.buffer))).toBe(true);
      const [a, b] = [cellBuckets(cells, g), cellBuckets(want, g)];
      expect(Buffer.from(a.order.buffer).equals(Buffer.from(b.order.buffer)) && Buffer.from(a.start.buffer).equals(Buffer.from(b.start.buffer))).toBe(true);
    }
  });
});
