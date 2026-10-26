import { describe, expect, it } from "vitest";
import { AEF_PREVIEW_NODATA, aefPreview, MAX_AOI_SIDE, type AefEntry, type Aoi } from "../../../src/core/aef";
import { aoiGrid, selectEntries, utmEpsg } from "../../../src/core/aoi";
import { fromLonLat } from "../../../src/core/crs";

// Tester edge cases for spec 002 criteria 2-5.
const rect = (w: number, s: number, e: number, n: number): [number, number][] => [[w, s], [e, s], [e, n], [w, n], [w, s]];
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("utmEpsg edges (tester, criterion 2)", () => {
  it.each([
    [-180, -10, 32701], [180, -10, 32760], [179.999, 0, 32660], [-174, 1, 32602], [-174.0001, 1, 32601],
    [0, 0, 32631], [-0.0001, 0, 32630], [6, -0.0001, 32732], [3, -0, 32631],
  ])("(%d, %d) -> %d", (lon, lat, epsg) => expect(utmEpsg(lon, lat)).toBe(epsg));
});

describe("aoiGrid properties (tester, criterion 3)", () => {
  it("random rectangles in both hemispheres: 10 m origin and far corner, densely sampled edges inside, sides within the limit", () => {
    const r = rng(42);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const zone = Math.floor(r() * 60);
      const lon0 = -180 + zone * 6 + r() * 5.8, lat0 = (r() - 0.5) * 160;
      const w = lon0, s = lat0, e = Math.min(-180 + zone * 6 + 5.999, lon0 + r() * 0.3), n = lat0 + r() * 0.2;
      if (Math.sign(s) !== Math.sign(n) || s === 0 || n === 0) continue;
      const aoi = aoiGrid(rect(w, s, e, n));
      if (aoi === "zones") throw new Error(`zones for one zone ${[w, s, e, n]}`);
      const epsg = utmEpsg(w, s);
      // reference bbox over 400 steps per edge, independent of the implementation's 16
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const ring = rect(w, s, e, n);
      for (let k = 0; k < 4; k++) for (let t = 0; t <= 400; t++) {
        const [ax, ay] = ring[k]!, [bx, by] = ring[k + 1]!;
        const [x, y] = fromLonLat(epsg, ax + ((bx - ax) * t) / 400, ay + ((by - ay) * t) / 400);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      const gw = Math.ceil(x1 / 10) - Math.floor(x0 / 10), gh = Math.ceil(y1 / 10) - Math.floor(y0 / 10);
      if (aoi === "size") { expect(Math.max(gw, gh)).toBeGreaterThan(MAX_AOI_SIDE - 1); continue; }
      expect(aoi.epsg).toBe(epsg);
      const [ox, sx, rx, oy, ry, sy] = aoi.gt;
      expect([sx, rx, ry, sy]).toEqual([10, 0, 0, -10]);
      expect(ox % 10).toBe(0); expect(oy % 10).toBe(0);
      expect(aoi.width).toBeLessThanOrEqual(MAX_AOI_SIDE); expect(aoi.height).toBeLessThanOrEqual(MAX_AOI_SIDE);
      const fx = ox + 10 * aoi.width, fy = oy - 10 * aoi.height;
      expect(x0).toBeGreaterThanOrEqual(ox - 1e-6); expect(x1).toBeLessThanOrEqual(fx + 1e-6);
      expect(y0).toBeGreaterThanOrEqual(fy - 1e-6); expect(y1).toBeLessThanOrEqual(oy + 1e-6);
      // snapped outward by less than one pixel per side
      expect(x0 - ox).toBeLessThan(10 + 1e-6); expect(oy - y1).toBeLessThan(10 + 1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("antimeridian-side zones: a ring touching lon 180 is zone 60, touching -180 is zone 1", () => {
    expect((aoiGrid(rect(179.9, 10, 180, 10.05)) as Aoi).epsg).toBe(32660);
    expect((aoiGrid(rect(-180, -10.05, -179.9, -10)) as Aoi).epsg).toBe(32701);
  });

  it("a ring on the zone meridian or the equator follows the vertex rule", () => {
    expect((aoiGrid(rect(6, 50, 6.1, 50.1)) as Aoi).epsg).toBe(32632);
    expect(aoiGrid(rect(5.9, 50, 6, 50.1))).toBe("zones"); // vertices at 6.0 are zone 32
    expect((aoiGrid(rect(3, 0, 3.1, 0.1)) as Aoi).epsg).toBe(32631);
    expect(aoiGrid(rect(3, -0.1, 3.1, 0))).toBe("zones"); // vertices at lat 0 are north
  });

  it("an open ring gives the same grid as the closed ring", () => {
    const closed = rect(-80.95, 25.2, -80.9, 25.25);
    expect(aoiGrid(closed.slice(0, 4))).toEqual(aoiGrid(closed));
  });
});

describe("selectEntries edges (tester, criterion 4)", () => {
  const aoi: Aoi = { epsg: 32617, gt: [1000, 10, 0, 2000, 0, -10], width: 50, height: 50 };
  const e = (x0: number, y0: number, x1: number, y1: number, o: Partial<AefEntry> = {}): AefEntry => ({ year: 2021, epsg: 32617, path: `${x0},${y0}`, x0, y0, x1, y1, ...o });
  it("excludes edge-touching entries on every side and another zone; keeps a 1 m sliver", () => {
    const index = [
      e(500, 1500, 1000, 2000), e(1000, 1000, 1500, 1500), e(500, 500, 1000, 1500), // W, S, SW corner touch
      e(1200, 1600, 1300, 1700, { epsg: 32618 }),
      e(1499, 1700, 2000, 1800), // 1 m overlap on the east
      e(1100, 1999, 1200, 3000), // 1 m overlap on the north
    ];
    expect(selectEntries(index, aoi, 2021)).toEqual([index[4], index[5]]);
  });

  // Tester found a degenerate entry (zero width) inside the AOI was selected (F4).
  it("a zero-area entry inside the AOI is not selected", () => {
    expect(selectEntries([e(1200, 1600, 1200, 1700), e(1200, 1600, 1300, 1600)], aoi, 2021)).toEqual([]);
  });

  it("an empty index selects nothing", () => {
    expect(selectEntries([], aoi, 2021)).toEqual([]);
  });
});

describe("aefPreview edges (tester, criterion 5)", () => {
  const tile = (v: number[]) => ({ x0: 0, y0: 0, width: v.length, height: 1, nodata: null, bands: Array.from({ length: 64 }, () => Float32Array.from(v)) });
  it("Float32 rounding of -0.3 and 0.3 still gives 0 and 255; infinities clamp", () => {
    for (const b of aefPreview(tile([-0.3, 0.3, Infinity, -Infinity, 1e-9])).bands) expect(Array.from(b)).toEqual([0, 255, 255, 0, 128]);
  });

  it("NaN in one preview band only is nodata in that band only", () => {
    const t = tile([0.1, 0.1]);
    t.bands[16]![1] = NaN;
    const out = aefPreview(t).bands.map((b) => Array.from(b));
    expect(out[1]![1]).toBe(AEF_PREVIEW_NODATA);
    expect(out[0]![1]).toBe(out[0]![0]);
  });

  it("a tile with no pixels gives an empty preview", () => {
    expect(aefPreview({ x0: 0, y0: 0, width: 0, height: 0, nodata: null, bands: Array.from({ length: 64 }, () => new Float32Array(0)) }).bands.map((b) => b.length)).toEqual([0, 0, 0]);
  });
});
