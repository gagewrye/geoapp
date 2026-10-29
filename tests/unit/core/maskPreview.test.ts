import { describe, expect, it } from "vitest";
import { fromLonLat, invertAffine } from "../../../src/core/crs";
import { tileWindows } from "../../../src/core/grid";
import { cellBuckets, fillPreview, hideWindow, paintPreview, previewCells } from "../../../src/core/maskPreview";
import type { Affine, Grid } from "../../../src/core/types";

// Spec 014 criteria 1 (previewCells) and 2 (paintPreview), plus the per-window helpers the import and display use.

const R = 6378137;
const mercX = (lon: number) => (R * lon * Math.PI) / 180;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const lonOf = (x: number) => (x / R) * (180 / Math.PI);
const latOf = (y: number) => (Math.atan(Math.sinh(y / R)) * 180) / Math.PI;

// spec 003's EPSG:32633 fixture grid (tests/unit/core/labelQuads.test.ts)
const gt: Affine = [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30];
const grid: Grid = { epsg: 32633, gt, width: 600, height: 520 };

describe("previewCells (criterion 1)", () => {
  const maxSide = 200;
  const pv = previewCells(grid, maxSide);

  it("gives each preview pixel the floor of the inverse geotransform of its centre, by brute force; off-raster cells are -1, -1", () => {
    const [tl, , br] = pv.corners as [[number, number], [number, number], [number, number]];
    const x0 = mercX(tl[0]), x1 = mercX(br[0]), yTop = mercY(tl[1]), yBot = mercY(br[1]);
    let bad = 0, off = 0, on = 0;
    for (let v = 0; v < pv.height; v++) for (let u = 0; u < pv.width; u++) {
      const lon = lonOf(x0 + ((u + 0.5) * (x1 - x0)) / pv.width), lat = latOf(yTop - ((v + 0.5) * (yTop - yBot)) / pv.height);
      const [c, r] = invertAffine(gt, ...fromLonLat(32633, lon, lat)).map(Math.floor) as [number, number];
      const inside = c >= 0 && c < grid.width && r >= 0 && r < grid.height;
      const p = v * pv.width + u;
      const want = inside ? [c, r] : [-1, -1];
      if (pv.cells[2 * p] !== want[0] || pv.cells[2 * p + 1] !== want[1]) bad++;
      if (inside) on++; else off++;
    }
    expect(bad).toBe(0);
    // UTM is rotated against Mercator, so the fitted rectangle has off-raster corners
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off);
  });

  it("has corners forming a Mercator rectangle (TL, TR, BR, BL), its longest side maxSide", () => {
    const [tl, tr, br, bl] = pv.corners as [number, number][];
    expect(tl![0]).toBe(bl![0]);
    expect(tr![0]).toBe(br![0]);
    expect(tl![1]).toBe(tr![1]);
    expect(bl![1]).toBe(br![1]);
    expect(tl![0]).toBeLessThan(tr![0]);
    expect(bl![1]).toBeLessThan(tl![1]);
    expect(Math.max(pv.width, pv.height)).toBe(maxSide);
    expect(pv.cells.length).toBe(2 * pv.width * pv.height);
  });

  it("cellBuckets puts every on-raster preview pixel in exactly its window's bucket", () => {
    const b = cellBuckets(pv.cells, grid);
    const windows = tileWindows(grid.width, grid.height);
    expect(b.start.length).toBe(windows.length + 1);
    const seen = new Uint8Array(pv.width * pv.height);
    windows.forEach((w, wi) => {
      for (let k = b.start[wi]!; k < b.start[wi + 1]!; k++) {
        const p = b.order[k]!, c = pv.cells[2 * p]!, r = pv.cells[2 * p + 1]!;
        expect(c >= w.x0 && c < w.x0 + w.width && r >= w.y0 && r < w.y0 + w.height).toBe(true);
        seen[p]!++;
      }
    });
    for (let p = 0; p < seen.length; p++) expect(seen[p]).toBe(pv.cells[2 * p]! >= 0 ? 1 : 0);
  });

  it("fillPreview and hideWindow touch exactly one window's pixels", () => {
    const b = cellBuckets(pv.cells, grid);
    const w = tileWindows(grid.width, grid.height)[4]!; // 0,256
    const labels = new Uint8Array(w.width * w.height).map((_, i) => 1 + (i % 7));
    const values = new Uint8Array(pv.width * pv.height);
    fillPreview(values, pv.cells, b, w, labels);
    const hidden = new Uint8Array(values.length);
    hideWindow(hidden, b, w.x0, w.y0, true);
    for (let p = 0; p < values.length; p++) {
      const c = pv.cells[2 * p]!, r = pv.cells[2 * p + 1]!;
      const inW = c >= w.x0 && c < w.x0 + w.width && r >= w.y0 && r < w.y0 + w.height;
      expect(values[p]).toBe(inW ? labels[(r - w.y0) * w.width + (c - w.x0)] : 0);
      expect(hidden[p]).toBe(inW ? 1 : 0);
    }
    hideWindow(hidden, b, w.x0, w.y0, false);
    expect(hidden.every((v) => v === 0)).toBe(true);
  });
});

describe("paintPreview (criterion 2)", () => {
  it("gives class colours at alpha 255, and alpha 0 for value 0 and for hidden pixels", () => {
    const values = new Uint8Array([0, 1, 2, 2, 1]);
    const hidden = new Uint8Array([0, 0, 0, 1, 1]);
    const rgba = new Uint8ClampedArray(20).fill(77);
    paintPreview(values, hidden, ["#102030", "#ff8001"], rgba);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 0, 0x10, 0x20, 0x30, 255, 0xff, 0x80, 0x01, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
