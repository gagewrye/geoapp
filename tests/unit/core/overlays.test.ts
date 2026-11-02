import { describe, expect, it } from "vitest";
import { planView, viewBox } from "../../../src/core/imagery";
import { cellBuckets, fillPreview, previewCells, unfillPreview } from "../../../src/core/maskPreview";
import { LABEL_OVERLAYS, overlayKeys } from "../../../src/core/overlays";
import { tileWindows } from "../../../src/core/grid";
import type { Affine, Grid } from "../../../src/core/types";

// Spec 048 criteria 3 (overlayKeys, viewBox) and 4 (unfillPreview).

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** The spec's rule, written plainly: keys whose 256 px window meets box, by squared distance of its centre to box's, ties row-major. */
function brute(keys: string[], [x0, y0, x1, y1]: number[], max: number): string[] {
  const cx = (x0! + x1!) / 2, cy = (y0! + y1!) / 2;
  const meets = keys.filter((k) => {
    const [x, y] = k.split(",").map(Number) as [number, number];
    return x < x1! && x + 256 > x0! && y < y1! && y + 256 > y0!;
  });
  const d = (k: string) => { const [x, y] = k.split(",").map(Number) as [number, number]; return (x + 128 - cx) ** 2 + (y + 128 - cy) ** 2; };
  const yx = (k: string) => k.split(",").map(Number).reverse() as [number, number];
  return meets.sort((a, b) => d(a) - d(b) || yx(a)[0] - yx(b)[0] || yx(a)[1] - yx(b)[1]).slice(0, max);
}

describe("overlayKeys (criterion 3)", () => {
  const all = tileWindows(256 * 40, 256 * 30).map((w) => `${w.x0},${w.y0}`); // 1,200 keys
  it("equals a brute-force filter and sort, at most max", () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const keys = all.filter(() => r() < 0.6);
      const x0 = Math.floor(r() * 9000), y0 = Math.floor(r() * 7000);
      const box: [number, number, number, number] = [x0, y0, Math.min(10240, x0 + 1 + Math.floor(r() * 6000)), Math.min(7680, y0 + 1 + Math.floor(r() * 5000))];
      const max = [1, 10, LABEL_OVERLAYS, 5000][i % 4]!;
      const got = overlayKeys(keys, box, max);
      expect(got).toEqual(brute(keys, box, max));
      expect(got.length).toBeLessThanOrEqual(max);
    }
  });
  it("breaks distance ties row-major", () => {
    // the box centre is equidistant from all four tiles around (256, 256)
    expect(overlayKeys(["256,256", "0,256", "256,0", "0,0"], [128, 128, 384, 384], 4)).toEqual(["0,0", "256,0", "0,256", "256,256"]);
  });
  it("returns nothing for a box off the raster", () => {
    expect(overlayKeys(all, [0, 0, 0, 0], 256)).toEqual([]);
    expect(overlayKeys(all, [500, 500, 400, 600], 256)).toEqual([]);
  });
  it("caps overlays at 256 tiles", () => { expect(LABEL_OVERLAYS).toBe(256); });
});

describe("viewBox (criterion 3)", () => {
  const PX = 1e-4;
  const GRID: Grid = { epsg: 4326, gt: [10, PX, 0, 1, 0, -PX], width: 20000, height: 16000 };
  const view = (d: number, c: number, r: number): [number, number, number, number] => {
    const lon = 10 + c * PX, lat = 1 - r * PX;
    return [lon - (d * 500 * PX), lat - (d * 400 * PX), lon + (d * 500 * PX), lat + (d * 400 * PX)];
  };
  it("is the box planView's full-resolution tiles cover", () => {
    for (const [d, c, r] of [[1, 10000, 8000], [0.5, 200, 15900], [1.5, 19990, 10], [1, 0, 0]] as const) {
      const box = viewBox(GRID, view(d, c, r))!;
      const p = planView(GRID, [], view(d, c, r), 1000, 800)!;
      expect(p.level.s).toBe(1);
      const [x0, y0, x1, y1] = box;
      const want = tileWindows(GRID.width, GRID.height).filter((t) => t.x0 < x1 && t.x0 + t.width > x0 && t.y0 < y1 && t.y0 + t.height > y0);
      expect(new Set(p.tiles.map((t) => `${t.x0},${t.y0}`))).toEqual(new Set(want.map((t) => `${t.x0},${t.y0}`)));
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(GRID.width);
    }
  });
  it("is empty off the raster", () => {
    const b = viewBox(GRID, view(1, -5000, -5000));
    expect(b === null || b[0] >= b[2] || b[1] >= b[3]).toBe(true);
  });
});

describe("unfillPreview (criterion 4)", () => {
  const gt: Affine = [613504.343 - 356.5 * 30, 30, 0, 5234037.466 + 300.5 * 30, 0, -30];
  const grid: Grid = { epsg: 32633, gt, width: 600, height: 520 };
  const pv = previewCells(grid, 200), buckets = cellBuckets(pv.cells, grid);
  const windows = tileWindows(grid.width, grid.height);
  it("after fillPreview restores the base values, or zeros without a base", () => {
    const n = pv.width * pv.height, base = Uint8Array.from({ length: n }, (_, i) => (i * 7) % 5);
    for (const b of [base, null]) {
      const values = b ? b.slice() : new Uint8Array(n);
      for (const w of windows) fillPreview(values, pv.cells, buckets, w, new Uint8Array(w.width * w.height).fill(9));
      expect(values.some((v) => v === 9)).toBe(true);
      for (const w of windows) unfillPreview(values, b, buckets, w.x0, w.y0);
      expect(values).toEqual(b ?? new Uint8Array(n));
    }
  });
  it("touches only its own window's pixels", () => {
    const n = pv.width * pv.height, values = new Uint8Array(n).fill(4);
    unfillPreview(values, null, buckets, 256, 256);
    const changed = [...values.keys()].filter((p) => values[p] === 0);
    expect(changed.length).toBeGreaterThan(0);
    for (const p of changed) expect([Math.floor(pv.cells[2 * p]! / 256), Math.floor(pv.cells[2 * p + 1]! / 256)]).toEqual([1, 1]);
  });
});
