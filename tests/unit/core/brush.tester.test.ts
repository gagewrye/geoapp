import { describe, expect, it } from "vitest";
import { fromLonLat, normalizeLon } from "../../../src/core/crs";
import { tileWindows } from "../../../src/core/grid";
import { MAX_LABEL_TILES, brush, emptyStore, tileKeys, tileWindow, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { maskBit, nodataMask } from "../../../src/core/nodata";
import { footprint, footprintRing, pixelAt, strokeCells, strokeCellsIn } from "../../../src/core/pixel";
import type { Grid, Tile } from "../../../src/core/types";
import { makeTile } from "../helpers/tiles";

// Tester: spec 003 criteria 1-4 and 18 at raster edges, partial tiles, the antimeridian and odd inputs.

const g4326 = (x0: number, y0: number, px: number, width: number, height: number): Grid =>
  ({ epsg: 4326, gt: [x0, px, 0, y0, 0, -px], width, height });

describe("pixelAt across 180 and world copies (criterion 1, tester)", () => {
  it("every world copy (lon + k*360, |k| <= 3) hits the same pixel on 4326, 3857 and UTM grids", () => {
    const [mx, my] = fromLonLat(3857, 12, 41);
    const [ux, uy] = fromLonLat(32633, 14, 45);
    const grids: Grid[] = [
      g4326(10, 50, 0.01, 1000, 1000),
      { epsg: 3857, gt: [mx, 10, 0, my, 0, -10], width: 5000, height: 5000 },
      { epsg: 32633, gt: [ux, 30, 0, uy, 0, -30], width: 4000, height: 4000 },
    ];
    const pts: [number, number][] = [[12.3456, 40.789], [14.0001, 44.5], [15.5, 45.5]];
    for (const g of grids) for (const [lon, lat] of pts) {
      const at = pixelAt(g, lon, lat);
      for (let k = -3; k <= 3; k++) expect(pixelAt(g, lon + 360 * k, lat), `${g.epsg} ${lon}+${k}*360`).toEqual(at);
    }
  });

  it("EPSG:32601 raster straddling 180 westwards: lon 179.8 and -180.2 (and +720) give one on-raster pixel", () => {
    // zone 1's central meridian is 177W; start at 179E, i.e. 4 degrees west of it
    const [x0, y0] = fromLonLat(32601, -181, -20);
    const g: Grid = { epsg: 32601, gt: [x0, 30, 0, y0, 0, -30], width: 20000, height: 100 };
    const a = pixelAt(g, 179.8, -20.001);
    expect(a[0]).toBeGreaterThan(0);
    expect(a[0]).toBeLessThan(g.width);
    expect(pixelAt(g, -180.2, -20.001)).toEqual(a);
    expect(pixelAt(g, 179.8 + 720, -20.001)).toEqual(a);
  });

  it("columns are continuous across 180 on a zone-60 raster: a pixel either side of the meridian is adjacent", () => {
    const [x0, y0] = fromLonLat(32660, 179, 5);
    const g: Grid = { epsg: 32660, gt: [x0, 30, 0, y0, 0, -30], width: 10000, height: 100 };
    const west = pixelAt(g, 179.99999, 4.9995), east = pixelAt(g, -179.99999, 4.9995), eastCopy = pixelAt(g, 180.00001, 4.9995);
    expect(east).toEqual(eastCopy);
    expect(Math.abs(east[0] - west[0])).toBeLessThanOrEqual(1);
    expect(east[1]).toBe(west[1]);
  });

  it("4326 raster whose east edge is exactly 180: the last column is reached from lon 179.995 and its +-360 copies", () => {
    const g = g4326(170, 10, 0.01, 1000, 100);
    for (const lon of [179.995, 179.995 - 360, 179.995 + 360]) expect(pixelAt(g, lon, 9.995)).toEqual([999, 0]);
  });

  it("normalizeLon keeps [-180, 180] and maps copies into it", () => {
    for (const v of [-180, 180, 0, 179.999]) expect(normalizeLon(v)).toBe(v);
    expect(normalizeLon(540)).toBe(-180); // the same meridian as 180
    expect(normalizeLon(-540.5)).toBeCloseTo(179.5, 12);
  });
});

describe("footprint at edges for every brush size (criterion 2, tester)", () => {
  const dims = { width: 300, height: 260 }; // partial edge tiles: 44 x 4 columns/rows past 256
  it("is the centred square for every size when it fits", () => {
    for (let s = 1; s <= 127; s += 2) {
      const h = (s - 1) / 2;
      expect(footprint(dims, 150, 130, s)).toEqual({ x0: 150 - h, y0: 130 - h, width: s, height: s });
    }
  });
  it("a size-127 footprint at each corner is the clipped 64 x 64 square, and its tileKeys stay on the raster", () => {
    expect(footprint(dims, 0, 0, 127)).toEqual({ x0: 0, y0: 0, width: 64, height: 64 });
    const br = footprint(dims, 299, 259, 127)!;
    expect(br).toEqual({ x0: 236, y0: 196, width: 64, height: 64 });
    expect(tileKeys(br)).toEqual(["0,0", "256,0", "0,256", "256,256"]);
  });
  it("a centre up to 63 px off the raster still meets it with size 127; 64 px off misses", () => {
    expect(footprint(dims, -63, 10, 127)).toEqual({ x0: 0, y0: 0, width: 1, height: 74 });
    expect(footprint(dims, -64, 10, 127)).toBeNull();
    expect(footprint(dims, 10, 259 + 63, 127)).toEqual({ x0: 0, y0: 259, width: 74, height: 1 });
    expect(footprint(dims, 10, 259 + 64, 127)).toBeNull();
  });
  it("footprintRing of a clipped window follows the clipped edges, not the unclipped square", () => {
    const g = g4326(10, 50, 0.01, 300, 260);
    const ring = footprintRing(g, footprint(g, 0, 0, 7)!);
    expect(ring[0]![0]).toBeCloseTo(10, 12);
    expect(ring[0]![1]).toBeCloseTo(50, 12);
    expect(ring[2]![0]).toBeCloseTo(10.04, 12);
    expect(ring[2]![1]).toBeCloseTo(49.96, 12);
  });
});

describe("strokeCells / strokeCellsIn (criterion 3, tester)", () => {
  it("single-cell and reversed strokes: both ends, 8-connected, max(|dc|, |dr|) + 1 cells, reverse is the same set", () => {
    expect(strokeCells([4, 4], [4, 4])).toEqual([[4, 4]]);
    for (const [a, b] of [[[0, 0], [7, 3]], [[-5, 9], [12, -2]], [[1, 1], [1, 40]]] as [[number, number], [number, number]][]) {
      const f = strokeCells(a, b), r = strokeCells(b, a);
      expect(f).toHaveLength(r.length);
      expect(r[0]).toEqual(b);
      expect(r.at(-1)).toEqual(a);
    }
  });
  it("a box the stroke never meets gives no cells, also for a horizontal or vertical stroke", () => {
    const box = { x0: 0, y0: 0, x1: 99, y1: 99 };
    expect(strokeCellsIn([-50, 200], [500, 200], box)).toEqual([]);
    expect(strokeCellsIn([200, -50], [200, 500], box)).toEqual([]);
    expect(strokeCellsIn([-1e9, -1e9 + 500], [-1e9 + 1, 1e9], box)).toEqual([]);
    expect(strokeCellsIn([-3, -3], [-3, -3], box)).toEqual([]);
  });
});

/** Every mask of a store whose nodata(col, row) pixels are set, built from 2-band tiles (band 2 nodata -9). */
function masks(store: LabelStore, nodata: (c: number, r: number) => boolean): NodataMasks {
  const m: NodataMasks = new Map();
  for (const w of tileWindows(store.width, store.height))
    m.set(`${w.x0},${w.y0}`, nodataMask(makeTile(w.x0, w.y0, w.width, w.height, 2, (k, c, r) => (k === 1 && nodata(c, r) ? -9 : 1), -9)));
  return m;
}
const label = (s: LabelStore, c: number, r: number) => {
  const w = tileWindow(s, c - (c % 256), r - (r % 256));
  return s.tiles.get(`${w.x0},${w.y0}`)?.[(r - w.y0) * w.width + (c - w.x0)] ?? 0;
};

describe("brush on partial edge tiles and with odd inputs (criterion 4, tester)", () => {
  it("a size-127 dab at the bottom-right corner of a 300x260 raster labels exactly the clipped window minus nodata in all 4 (partial) tiles", () => {
    const s = emptyStore(300, 260);
    const nd = (c: number, r: number) => (c + 3 * r) % 11 === 0 || (c >= 280 && r >= 250);
    const m = masks(s, nd);
    const w = footprint(s, 299, 259, 127)!;
    expect(brush(s, m, w, 4, false)).toBe("ok");
    for (let r = 0; r < 260; r++) for (let c = 0; c < 300; c++) {
      const inW = c >= w.x0 && r >= w.y0;
      expect(label(s, c, r)).toBe(inW && !nd(c, r) ? 4 : 0);
    }
    expect([...s.tiles.keys()].sort()).toEqual(["0,0", "0,256", "256,0", "256,256"]);
    for (const [k, t] of s.tiles) { const [x, y] = k.split(",").map(Number) as [number, number]; const tw = tileWindow(s, x, y); expect(t).toHaveLength(tw.width * tw.height); }
  });

  it("a mask built for a partial tile uses that tile's width for bit order (pixel i = row * width + col)", () => {
    const t: Tile = makeTile(256, 256, 44, 4, 1, (_k, c, r) => (c === 299 && r === 257 ? NaN : 0));
    const m = nodataMask(t);
    expect(m).toHaveLength(Math.ceil((44 * 4) / 8));
    const i = (257 - 256) * 44 + (299 - 256);
    for (let j = 0; j < 44 * 4; j++) expect(maskBit(m, j)).toBe(j === i ? 1 : 0);
  });

  it("nodataMask: GDAL_NODATA NaN marks only NaN; an Infinity value or a -0 next to nodata 0 follows ===", () => {
    const b = Float32Array.from([NaN, 1, Infinity, -0]);
    expect([0, 1, 2, 3].map((i) => maskBit(nodataMask({ x0: 0, y0: 0, width: 4, height: 1, bands: [b], nodata: NaN }), i))).toEqual([1, 0, 0, 0]);
    expect([0, 1, 2, 3].map((i) => maskBit(nodataMask({ x0: 0, y0: 0, width: 4, height: 1, bands: [b], nodata: 0 }), i))).toEqual([1, 0, 0, 1]);
  });

  it("refuses label values outside 1..255 before touching the store", () => {
    const s = emptyStore(100, 100);
    const m = masks(s, () => false);
    for (const v of [0, 256, 1.5, -1, NaN]) expect(() => brush(s, m, { x0: 0, y0: 0, width: 3, height: 3 }, v, false)).toThrow(/1\.\.255/);
    expect(s.tiles.size).toBe(0);
  });

  it("an erase of a class that isn't there keeps every tile and pixel", () => {
    const s = emptyStore(600, 300);
    const m = masks(s, () => false);
    brush(s, m, { x0: 250, y0: 10, width: 10, height: 10 }, 1, false);
    const before = new Map([...s.tiles].map(([k, v]) => [k, v.slice()]));
    expect(brush(s, new Map(), { x0: 0, y0: 0, width: 600, height: 300 }, 2, true)).toBe("ok");
    expect([...s.tiles.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(Buffer.from(s.tiles.get(k)!).equals(Buffer.from(v))).toBe(true);
  });

  it("a paint that throws for a missing mask in its second tile has changed nothing in its first", () => {
    const s = emptyStore(600, 300);
    const m = masks(s, () => false);
    m.delete("256,0");
    expect(() => brush(s, m, { x0: 250, y0: 0, width: 10, height: 5 }, 1, false)).toThrow(/mask/);
    expect(s.tiles.size).toBe(0);
  });
});

describe(`brush at MAX_LABEL_TILES after an erase frees a tile (criterion 4, tester)`, { timeout: 30_000 }, () => {
  it("full, then erasing a tile's only label lets the same dab create the new tile", () => {
    const s = emptyStore(17 * 256, 16 * 256); // 272 tiles
    const all = masks(s, () => false);
    const wins = tileWindows(s.width, s.height);
    for (const w of wins.slice(0, MAX_LABEL_TILES)) brush(s, all, { x0: w.x0 + 3, y0: w.y0 + 3, width: 1, height: 1 }, 1, false);
    const dab = { x0: wins[MAX_LABEL_TILES]!.x0 + 10, y0: wins[MAX_LABEL_TILES]!.y0 + 10, width: 7, height: 7 };
    expect(brush(s, all, dab, 2, false)).toBe("full");
    expect(brush(s, new Map(), { x0: 3, y0: 3, width: 1, height: 1 }, 1, true)).toBe("ok");
    expect(s.tiles.size).toBe(MAX_LABEL_TILES - 1);
    expect(brush(s, all, dab, 2, false)).toBe("ok");
    expect(s.tiles.size).toBe(MAX_LABEL_TILES);
    expect(label(s, dab.x0 + 3, dab.y0 + 3)).toBe(2);
  });
});
