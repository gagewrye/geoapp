import { describe, expect, it } from "vitest";
import { fromLonLat, invertAffine } from "../../../src/core/crs";
import { latticeEach } from "../../../src/core/lattice";
import type { Grid } from "../../../src/core/types";
import { latOf, lonOf, mercatorGrid, mercBounds } from "../../../src/core/warp";

// Tester, spec 030 criterion 1: thin and tiny previews, sheared mappings, and real grids with extreme aspect or rotation.
const smooth = (u: number, v: number): [number, number] => [(u + 0.5) * 1.37 + Math.sin(v / 90) * 3, (v + 0.5) * 0.91 + (u * u) / 4000];

/** [pixels visited, pixels whose floor(c) or floor(r) differs from exact's]. */
function mismatches(W: number, H: number, exact: (u: number, v: number) => [number, number]): [number, number] {
  let bad = 0, seen = 0;
  latticeEach(W, H, exact, (o, c, r) => {
    seen++;
    const [ec, er] = exact(o % W, Math.floor(o / W));
    if (!Object.is(Math.floor(c), Math.floor(ec)) || !Object.is(Math.floor(r), Math.floor(er))) bad++;
  });
  return [seen, bad];
}

/** The same check through mercatorGrid on a real grid, against the pre-030 exact loop. */
function gridMismatches(g: Grid, maxSide: number): [number, number] {
  const win = { x0: 0, y0: 0, width: g.width, height: g.height };
  const [mx0, my0, mx1, my1] = mercBounds(win, g.gt, g.epsg);
  const { width, height, each } = mercatorGrid(win, g.gt, g.epsg, maxSide);
  const sx = (mx1 - mx0) / width, sy = (my1 - my0) / height;
  let bad = 0, seen = 0;
  each((o, c, r) => {
    seen++;
    const u = o % width, v = Math.floor(o / width);
    const [ec, er] = invertAffine(g.gt, ...fromLonLat(g.epsg, lonOf(mx0 + (u + 0.5) * sx), latOf(my1 - (v + 0.5) * sy)));
    if (!Object.is(Math.floor(c), Math.floor(ec)) || !Object.is(Math.floor(r), Math.floor(er))) bad++;
  });
  expect(seen).toBe(width * height);
  return [seen, bad];
}

describe("latticeEach shapes (tester, spec 030)", () => {
  it.each([[1, 1], [1, 50], [50, 1], [2, 2], [2, 300], [300, 2], [3, 17], [17, 3], [16, 16], [17, 17], [33, 18], [1024, 5]])(
    "a %i x %i preview visits every pixel once with exact floors", (w, h) => {
      expect(mismatches(w, h, smooth)).toEqual([w * h, 0]);
    });

  it("a sheared, slightly curved mapping (a rotated raster)", () => {
    expect(mismatches(500, 300, (u, v) => [u * 0.7 + v * 0.4 + 0.25, -u * 0.3 + v * 1.1 + (u * v) / 1e5])).toEqual([150000, 0]);
  });
});

describe("mercatorGrid on real grids of awkward shape (tester, spec 030 criterion 1)", () => {
  const [x, y] = fromLonLat(32618, -77.16, 17.83);
  it("a 6485 x 40 strip of the typical grid (a preview a few pixels tall)", () => {
    expect(gridMismatches({ epsg: 32618, gt: [Math.round(x), 0.1, 0, Math.round(y), 0, -0.1], width: 6485, height: 40 }, 1024)[1]).toBe(0);
  });

  it("a 40 x 6485 strip of the typical grid (a preview a few pixels wide)", () => {
    expect(gridMismatches({ epsg: 32618, gt: [Math.round(x), 0.1, 0, Math.round(y), 0, -0.1], width: 40, height: 6485 }, 1024)[1]).toBe(0);
  });

  it("the typical grid rotated 30 degrees", () => {
    const a = Math.PI / 6, p = 0.1;
    const g: Grid = { epsg: 32618, gt: [Math.round(x), p * Math.cos(a), -p * Math.sin(a), Math.round(y), -p * Math.sin(a), -p * Math.cos(a)], width: 6485, height: 6485 };
    expect(gridMismatches(g, 1024)[1]).toBe(0);
  });

  it("a coarse EPSG:4326 grid from 84 N down to 40 N (strong Mercator curvature)", () => {
    expect(gridMismatches({ epsg: 4326, gt: [10, 0.05, 0, 84, 0, -0.05], width: 1200, height: 880 }, 1024)[1]).toBe(0);
  });

  it("a small raster (preview larger than the source): 37 x 23 at 30 m", () => {
    const [ux, uy] = fromLonLat(32633, 18, 63);
    expect(gridMismatches({ epsg: 32633, gt: [ux, 30, 0, uy, 0, -30], width: 37, height: 23 }, 1024)[1]).toBe(0);
  });
});
