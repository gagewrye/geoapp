import { describe, expect, it } from "vitest";
import { samplePixels } from "../../../src/core/sample";
import type { PixelPolygon, Tile } from "../../../src/core/types";
import { tileWindows } from "../../../src/core/grid";
import { makeTile } from "../helpers/tiles";

// Edge cases for criterion 5, checked against an independent brute-force even-odd reference.

const id = (_k: number, c: number, r: number) => c * 10000 + r; // unique per pixel in band 1

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Even-odd point-in-polygon by ray casting over all rings. */
function insideEvenOdd(p: PixelPolygon, x: number, y: number): boolean {
  let inside = false;
  for (const ring of p.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Reference samples as "pixelId,label" strings: centre rule, conflicts and nodata dropped. */
function reference(width: number, height: number, polys: PixelPolygon[], skip: (c: number, r: number) => boolean = () => false): string[] {
  const out: string[] = [];
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    if (skip(c, r)) continue;
    const labels = new Set(polys.filter((p) => insideEvenOdd(p, c + 0.5, r + 0.5)).map((p) => p.label));
    if (labels.size === 1) out.push(`${id(0, c, r)},${[...labels][0]}`);
  }
  return out.sort();
}

function keys(s: { X: Float32Array; y: Uint8Array }, nb = 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.y.length; i++) out.push(`${s.X[i * nb]},${s.y[i]}`);
  return out;
}

function sampleGrid(width: number, height: number, polys: PixelPolygon[], size: number, f = id, nodata: number | null = null): string[] {
  const out: string[] = [];
  for (const w of tileWindows(width, height, size)) out.push(...keys(samplePixels(makeTile(w.x0, w.y0, w.width, w.height, 1, f, nodata), polys, [1])));
  return out.sort();
}

function randomPolygon(rnd: () => number, w: number, h: number, label: number, n: number, snap: boolean): PixelPolygon {
  const pt = (): [number, number] => {
    // allow vertices outside the raster; snapping to half-integers hits pixel centres exactly
    const x = -5 + rnd() * (w + 10), y = -5 + rnd() * (h + 10);
    return snap ? [Math.round(x * 2) / 2, Math.round(y * 2) / 2] : [x, y];
  };
  return { label, rings: [Array.from({ length: n }, pt)] };
}

describe("samplePixels edge cases (criterion 5)", () => {
  it("matches a brute-force even-odd centre rule on random (self-intersecting) polygons", () => {
    const rnd = lcg(7);
    for (let trial = 0; trial < 40; trial++) {
      const polys = [randomPolygon(rnd, 40, 30, 0, 3 + (trial % 6), false), randomPolygon(rnd, 40, 30, 1 + (trial % 3), 4, false)];
      const got = keys(samplePixels(makeTile(0, 0, 40, 30, 1, id), polys, [1])).sort();
      expect(got, `trial ${trial}`).toEqual(reference(40, 30, polys));
    }
  });

  it("gives the same multiset for any tiling, including partial edge tiles and vertices on pixel centres", () => {
    const rnd = lcg(11);
    for (let trial = 0; trial < 30; trial++) {
      const polys = [randomPolygon(rnd, 37, 29, 0, 5, true), randomPolygon(rnd, 37, 29, 1, 4, true), randomPolygon(rnd, 37, 29, 0, 3, true)];
      const whole = sampleGrid(37, 29, polys, 1000);
      for (const size of [1, 2, 5, 8, 16]) expect(sampleGrid(37, 29, polys, size), `trial ${trial} size ${size}`).toEqual(whole);
    }
  });

  it("samples a 300x260 raster on the real 256 grid identically to one tile", () => {
    const polys: PixelPolygon[] = [
      { label: 0, rings: [[[200.3, 200.7], [290.2, 230.1], [270.9, 259.6], [210.4, 255.5]]] },
      { label: 1, rings: [[[250, 10], [262, 10], [262, 300], [250, 300]], [[254.3, 100.2], [258.7, 100.9], [258.1, 104.6]]] },
    ];
    const whole = sampleGrid(300, 260, polys, 100000);
    expect(whole.length).toBeGreaterThan(1000);
    expect(sampleGrid(300, 260, polys, 256)).toEqual(whole);
    expect(whole).toEqual(reference(300, 260, polys));
  });

  it("returns empty arrays for no polygons, polygons outside the tile, and zero-area polygons", () => {
    const t = makeTile(0, 0, 8, 8, 2, id);
    for (const polys of [[], [{ label: 0, rings: [[[20, 20], [30, 20], [30, 30]]] }], [{ label: 0, rings: [[[1, 1], [5, 1], [3, 1]]] }]] as PixelPolygon[][]) {
      const s = samplePixels(t, polys, [1, 2]);
      expect(s.X).toBeInstanceOf(Float32Array);
      expect(s.y).toBeInstanceOf(Uint8Array);
      expect(s.y).toHaveLength(0);
      expect(s.X).toHaveLength(0);
    }
  });

  it("clips polygons that extend past the raster edge (negative and beyond-size coordinates)", () => {
    const polys: PixelPolygon[] = [{ label: 4, rings: [[[-10, -10], [3, -10], [3, 2], [-10, 2]]] }];
    const s = samplePixels(makeTile(0, 0, 5, 5, 1, id), polys, [1]);
    expect(keys(s).sort()).toEqual(["0,4", "1,4", "10000,4", "10001,4", "20000,4", "20001,4"].sort());
  });

  it("keeps a single-class polygon set and a single labelled pixel", () => {
    const s = samplePixels(makeTile(0, 0, 4, 4, 1, id), [{ label: 0, rings: [[[2.4, 1.4], [2.6, 1.4], [2.6, 1.6], [2.4, 1.6]]] }], [1]);
    expect(keys(s)).toEqual(["20001,0"]);
  });

  it("drops NaN pixels when nodata is null, and nodata pixels across tile boundaries", () => {
    const f = (_k: number, c: number, r: number) => ((c + r) % 7 === 0 ? NaN : (c * 3 + r) % 11 === 0 ? -1 : id(0, c, r));
    const polys: PixelPolygon[] = [{ label: 2, rings: [[[0.2, 0.1], [19.7, 3.3], [15.2, 17.9], [1.1, 14.2]]] }];
    const skipNan = (c: number, r: number) => (c + r) % 7 === 0;
    const skipBoth = (c: number, r: number) => skipNan(c, r) || (c * 3 + r) % 11 === 0;
    // nodata null: NaN still dropped, -1 kept
    const nullNd = sampleGrid(20, 18, polys, 6, f, null);
    expect(nullNd.some((k) => k.startsWith("-1,"))).toBe(true);
    expect(nullNd.filter((k) => !k.startsWith("-1,")).length).toBe(reference(20, 18, polys, skipBoth).length);
    expect(nullNd.length).toBe(reference(20, 18, polys, skipNan).length);
    // nodata -1: both dropped, same for every tiling
    const nd = sampleGrid(20, 18, polys, 6, f, -1);
    expect(nd).toEqual(reference(20, 18, polys, skipBoth));
    expect(sampleGrid(20, 18, polys, 4, f, -1)).toEqual(nd);
  });

  it("treats NaN as nodata even when tile.nodata is NaN", () => {
    const t: Tile = makeTile(0, 0, 3, 1, 1, (_k, c) => (c === 1 ? NaN : c), NaN);
    const s = samplePixels(t, [{ label: 0, rings: [[[0, 0], [3, 0], [3, 1], [0, 1]]] }], [1]);
    expect([...s.X]).toEqual([0, 2]);
  });
});
