import { describe, expect, it } from "vitest";
import { blockWindows, IMAGERY_TILES, imageryQuads, MAX_READ_BYTES, planView, rowReads, toRgba, type Overview } from "../../../src/core/imagery";
import type { Window } from "../../../src/core/grid";
import { QUAD_ERR, tileQuads } from "../../../src/core/labelQuads";
import { tileWindow } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { warpPreview } from "../../../src/core/warp";

// Spec 020. A 4326 grid at the equator: 1e-4 degree pixels, so a view's pixel count follows its lon/lat span.
const PX = 1e-4;
const GRID: Grid = { epsg: 4326, gt: [10, PX, 0, 1, 0, -PX], width: 20000, height: 16000 };
const CSS_W = 1000, CSS_H = 800;

/** Bounds [w, s, e, n] of a CSS_W x CSS_H view centred on raster pixel (c, r) at d source pixels per CSS pixel. */
function view(d: number, c = 10000, r = 8000, w = CSS_W, h = CSS_H): [number, number, number, number] {
  const lon = 10 + c * PX, lat = 1 - r * PX;
  return [lon - (d * w * PX) / 2, lat - (d * h * PX) / 2, lon + (d * w * PX) / 2, lat + (d * h * PX) / 2];
}

const contains = (outer: Window, x: number, y: number) => x >= outer.x0 && x < outer.x0 + outer.width && y >= outer.y0 && y < outer.y0 + outer.height;

describe("planView (criterion 1)", () => {
  it.each([[0.5, 1], [1, 1], [1.9, 1], [2, 2], [7.9, 4]])("at %f source px per CSS px, s is %i", (d, s) => {
    const p = planView(GRID, [], view(d), CSS_W, CSS_H)!;
    expect(p.level.s).toBe(s);
  });

  it("gives 256-aligned tiles clipped to the raster that cover the view", () => {
    for (const [d, c, r] of [[1, 10000, 8000], [3, 200, 15900], [2.5, 19990, 10]]) {
      const p = planView(GRID, [], view(d!, c, r), CSS_W, CSS_H)!;
      const { s, grid } = p.level;
      expect(grid.width).toBe(Math.ceil(GRID.width / s));
      for (const t of p.tiles) {
        expect(t.x0 % 256).toBe(0);
        expect(t.y0 % 256).toBe(0);
        expect(t.width).toBe(Math.min(256, grid.width - t.x0));
        expect(t.height).toBe(Math.min(256, grid.height - t.y0));
      }
      expect(new Set(p.tiles.map((t) => `${t.x0},${t.y0}`)).size).toBe(p.tiles.length);
      // every raster pixel in the view lies in some tile
      const half = (d! * CSS_W) / 2, halfH = (d! * CSS_H) / 2;
      for (let y = Math.max(0, r! - halfH); y < Math.min(GRID.height, r! + halfH); y += 37) {
        for (let x = Math.max(0, c! - half); x < Math.min(GRID.width, c! + half); x += 37) {
          expect(p.tiles.some((t) => contains(t, Math.floor(x / s), Math.floor(y / s)))).toBe(true);
        }
      }
    }
  });

  it("sorts tiles centre first", () => {
    const p = planView(GRID, [], view(1, 5000, 5000), CSS_W, CSS_H)!;
    const dist = (t: Window) => Math.hypot(t.x0 + t.width / 2 - 5000, t.y0 + t.height / 2 - 5000);
    const ds = p.tiles.map(dist);
    expect(ds).toEqual([...ds].sort((a, b) => a - b));
  });

  it("gives no tiles for a view off the raster", () => {
    const p = planView(GRID, [], view(1, -5000, -5000), CSS_W, CSS_H);
    expect(p?.tiles ?? []).toEqual([]);
  });

  it(`never plans more than IMAGERY_TILES / 2 tiles`, () => {
    for (const [w, h] of [[8000, 8000], [6000, 3000], [4100, 4100]]) {
      const p = planView(GRID, [], view(1, 10000, 8000, w, h), w!, h!);
      expect(p).not.toBeNull();
      expect(p!.tiles.length).toBeGreaterThan(0);
      expect(p!.tiles.length).toBeLessThanOrEqual(IMAGERY_TILES / 2);
      expect(p!.level.s).toBeGreaterThan(1);
    }
  });
});

describe("level choice (criterion 2)", () => {
  const ovs: Overview[] = [2, 4, 8].map((k, i) => ({ index: i + 1, width: Math.ceil(GRID.width / k), height: Math.ceil(GRID.height / k) }));

  it("uses overviews at 2, 4 and 8, on the overview's grid", () => {
    for (const [d, s, index] of [[2, 2, 1], [5, 4, 2], [9, 8, 3]]) {
      const p = planView(GRID, ovs, view(d!), CSS_W, CSS_H)!;
      expect(p.level.s).toBe(s);
      expect(p.level.overview).toBe(index);
      const o = ovs[index! - 1]!;
      expect(p.level.grid).toEqual({ ...GRID, width: o.width, height: o.height, gt: [10, PX * GRID.width / o.width, 0, 1, 0, -PX * GRID.height / o.height] });
    }
  });

  it("without overviews samples full resolution up to s = 4, and gives null at s = 8", () => {
    for (const d of [1, 2, 4]) expect(planView(GRID, [], view(d), CSS_W, CSS_H)!.level.overview).toBeNull();
    expect(planView(GRID, [], view(9), CSS_W, CSS_H)).toBeNull();
  });

  it("ignores an overview 2% off size", () => {
    const off: Overview[] = [{ index: 1, width: Math.round((GRID.width / 2) * 1.02), height: GRID.height / 2 }];
    expect(planView(GRID, off, view(2), CSS_W, CSS_H)!.level.overview).toBeNull();
    const near: Overview[] = [{ index: 1, width: Math.round((GRID.width / 2) * 1.005), height: GRID.height / 2 }];
    expect(planView(GRID, near, view(2), CSS_W, CSS_H)!.level.overview).toBe(1);
  });
});

describe("imagery quads (criterion 3)", () => {
  it("at s = 1 equal the label overlay's quads for the same key", () => {
    const grids: Grid[] = [GRID, { epsg: 32633, gt: [613504 - 356.5 * 30, 30, 0, 5234037 + 300.5 * 30, 0, -30], width: 600, height: 520 },
      { epsg: 4326, gt: [10, 0.01, 0, 85, 0, -0.01], width: 512, height: 2500 }];
    for (const g of grids) {
      const level = { s: 1, grid: g, overview: null };
      for (const t of [{ x0: 0, y0: 0 }, { x0: 256, y0: 256 }, { x0: 512, y0: 0 }]) {
        if (t.x0 >= g.width || t.y0 >= g.height) continue;
        const w = tileWindow(g, t.x0, t.y0);
        expect(imageryQuads(level, w)).toEqual(tileQuads(g, w, QUAD_ERR));
      }
    }
  });
});

describe("toRgba (criterion 5)", () => {
  // A 4326 raster at the equator whose preview grid is the raster's own grid, so warpPreview samples each pixel once.
  const W = 8, H = 8, gt: [number, number, number, number, number, number] = [0, 0.001, 0, 0.004, 0, -0.001];
  const vals = (k: number) => Float32Array.from({ length: W * H }, (_, p) => (p * (k + 3)) % 97 - 10 + (k === 1 ? 0.37 : 0));

  it("matches warpPreview's mapping, per band and with one band", () => {
    for (const nb of [3, 1]) {
      const bands = Array.from({ length: nb }, (_, k) => vals(k));
      bands[0]![5] = NaN;
      bands[nb - 1]![9] = -9;
      const preview = warpPreview({ x0: 0, y0: 0, width: W, height: H, bands, nodata: -9 }, gt, 4326, W);
      expect([preview.width, preview.height]).toEqual([W, H]);
      const out = new Uint8ClampedArray(W * H * 4).fill(77);
      toRgba(bands, W * H, preview.ranges, -9, out);
      expect(Array.from(out)).toEqual(Array.from(preview.rgba).map((v, i) => (preview.rgba[i - (i % 4) + 3] === 0 ? 0 : v)));
      expect(out[4 * 5 + 3]).toBe(0);
      expect(out[4 * 9 + 3]).toBe(0);
    }
  });

  it("reads raw integer arrays and a fixed range", () => {
    const out = new Uint8ClampedArray(12);
    toRgba([Uint8Array.of(0, 128, 255)], 3, [[0, 255]], 255, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 0, 0, 0, 0]);
  });

  it("matches float32-rounded nodata in Float64 data, as readWindow does", () => {
    const out = new Uint8ClampedArray(8);
    toRgba([Float64Array.of(0.1, 0.5)], 2, [[0, 1]], Math.fround(0.1), out);
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(255);
  });
});

describe("rowReads (criterion 6)", () => {
  it("keeps each read within MAX_READ_BYTES and covers every tile's source pixels", () => {
    const cases: [number, number][] = [[1, 3], [4, 3], [4, 24], [2, 12], [1, 24]];
    for (const [d, bpp] of cases) {
      const p = planView(GRID, [], view(d, 10000, 8000, 4000, 1000), 4000, 1000)!;
      const { s } = p.level;
      const reads = rowReads(p.tiles, s, bpp);
      for (const r of reads) expect(r.width * r.height * bpp).toBeLessThanOrEqual(MAX_READ_BYTES);
      for (const t of p.tiles) {
        for (const [x, y] of [[t.x0, t.y0], [t.x0 + t.width - 1, t.y0 + t.height - 1], [t.x0 + (t.width >> 1), t.y0 + 3]]) {
          for (const [dx, dy] of [[0, 0], [s - 1, s - 1]]) expect(reads.some((r) => contains(r, x! * s + dx!, y! * s + dy!))).toBe(true);
        }
      }
      // one window per row of tiles unless it must split
      const rows = new Set(p.tiles.map((t) => t.y0)).size;
      if (p.tiles.length / rows * 256 * 256 * s * s * bpp <= MAX_READ_BYTES) expect(reads).toHaveLength(rows);
      else expect(reads.length).toBeGreaterThan(rows);
    }
  });

  it("reads only the tiles given, a row's gaps split it", () => {
    const tiles: Window[] = [{ x0: 0, y0: 0, width: 256, height: 256 }, { x0: 512, y0: 0, width: 256, height: 256 }, { x0: 256, y0: 256, width: 100, height: 256 }];
    expect(rowReads(tiles, 2, 1)).toEqual([
      { x0: 0, y0: 0, width: 512, height: 512 }, { x0: 1024, y0: 0, width: 512, height: 512 }, { x0: 512, y0: 512, width: 200, height: 512 },
    ]);
  });
});

describe("blockWindows", () => {
  const sampled = (n: number, f: number) => new Set(Array.from({ length: Math.ceil(n / f) }, (_, i) => Math.min(i * f + Math.floor(f / 2), n - 1)));
  it("reads each block holding a sampled pixel once, cropped to its sampled span", () => {
    for (const [w, h, bw, bh, f] of [[1000, 700, 256, 256, 3], [1000, 700, 1000, 1, 22], [1000, 700, 1000, 700, 1], [517, 300, 128, 64, 50]]) {
      const ws = blockWindows(w!, h!, bw!, bh!, f!);
      const cols = sampled(w!, f!), rows = sampled(h!, f!);
      const keys = ws.map((b) => `${Math.floor(b.x0 / bw!)},${Math.floor(b.y0 / bh!)}`);
      expect(new Set(keys).size).toBe(ws.length);
      for (const b of ws) {
        expect(Math.floor((b.x0 + b.width - 1) / bw!)).toBe(Math.floor(b.x0 / bw!));
        expect(Math.floor((b.y0 + b.height - 1) / bh!)).toBe(Math.floor(b.y0 / bh!));
        expect(cols.has(b.x0) && cols.has(b.x0 + b.width - 1) && rows.has(b.y0) && rows.has(b.y0 + b.height - 1)).toBe(true);
      }
      // keys are unique, so each sampled pixel's block is read once, and it is read
      const byKey = new Map(ws.map((b, i) => [keys[i]!, b]));
      let missed = 0;
      for (const c of cols) for (const r of rows) {
        const b = byKey.get(`${Math.floor(c / bw!)},${Math.floor(r / bh!)}`);
        if (!b || !contains(b, c, r)) missed++;
      }
      expect(missed).toBe(0);
    }
  });
});
