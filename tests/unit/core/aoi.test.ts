import { describe, expect, it } from "vitest";
import { aoiGrid, sameAoi, selectEntries, utmEpsg } from "../../../src/core/aoi";
import { fromLonLat, toLonLat } from "../../../src/core/crs";
import type { AefEntry, Aoi } from "../../../src/core/aef";

describe("utmEpsg (criterion 2)", () => {
  it.each([
    [-180, 10, 32601], [180, 10, 32660], [3, 0, 32631], [3, -0.1, 32731], [6, 50, 32632],
  ])("(%d, %d) -> %d", (lon, lat, epsg) => expect(utmEpsg(lon, lat)).toBe(epsg));
});

const rect = (w: number, s: number, e: number, n: number): [number, number][] => [[w, s], [e, s], [e, n], [w, n], [w, s]];

describe("aoiGrid (criterion 3)", () => {
  it("snaps outward to multiples of 10 m and contains the projected bbox", () => {
    const ring = rect(-80.95, 25.2, -80.9, 25.25);
    const aoi = aoiGrid(ring);
    if (typeof aoi === "string") throw new Error(aoi);
    expect(aoi.epsg).toBe(32617);
    const [x0, sx, rx, y1, ry, sy] = aoi.gt;
    expect([sx, rx, ry, sy]).toEqual([10, 0, 0, -10]);
    const x1 = x0 + 10 * aoi.width, y0 = y1 - 10 * aoi.height;
    for (const v of [x0, y1, x1, y0]) expect(v % 10).toBe(0);
    for (const [lon, lat] of ring) {
      const [x, y] = fromLonLat(32617, lon, lat);
      expect(x).toBeGreaterThanOrEqual(x0); expect(x).toBeLessThanOrEqual(x1);
      expect(y).toBeGreaterThanOrEqual(y0); expect(y).toBeLessThanOrEqual(y1);
    }
    // outward snapping adds less than one pixel on each side of the vertex bbox
    const xs = ring.map(([lon, lat]) => fromLonLat(32617, lon, lat));
    expect(Math.min(...xs.map((p) => p[0])) - x0).toBeLessThan(10);
    expect(y1 - Math.max(...xs.map((p) => p[1]))).toBeLessThan(10);
  });

  it("contains the projected edges, not only the vertices", () => {
    const aoi = aoiGrid(rect(-81.09, 25, -80.91, 25.18)) as Aoi; // straddles the zone meridian, so edges bow
    const x1 = aoi.gt[0] + 10 * aoi.width, y0 = aoi.gt[3] - 10 * aoi.height;
    for (let t = 0; t <= 1; t += 0.05) {
      for (const lat of [25, 25.18]) {
        const [x, y] = fromLonLat(32617, -81.09 + 0.18 * t, lat);
        expect(x).toBeGreaterThanOrEqual(aoi.gt[0]); expect(x).toBeLessThanOrEqual(x1);
        expect(y).toBeGreaterThanOrEqual(y0); expect(y).toBeLessThanOrEqual(aoi.gt[3]);
      }
    }
  });

  it("gives zones for rings across a zone boundary or the equator", () => {
    expect(aoiGrid(rect(5.9, 50, 6.1, 50.1))).toBe("zones");
    expect(aoiGrid(rect(3, -0.05, 3.1, 0.05))).toBe("zones");
  });

  it("gives size at 2049 px on a side, not at 2048", () => {
    // Vertices `inset` m inside the target pixel edges. Lon/lat edges bow up to ~4 m in UTM over
    // 20 km, so 2048 px needs a 5 m inset; any bowing only makes 2049 px larger.
    const at = (x: number, y: number) => toLonLat(32617, x, y);
    const ring = (w: number, h: number, inset = 0.01) => {
      const [x0, y0, x1, y1] = [500000 + inset, 2800000 + inset, 500000 + 10 * w - inset, 2800000 + 10 * h - inset];
      return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
    };
    const ok = aoiGrid(ring(2048, 2048, 5));
    expect(typeof ok === "string" ? ok : [ok.width, ok.height, ok.gt[0], ok.gt[3]]).toEqual([2048, 2048, 500000, 2820480]);
    expect(aoiGrid(ring(2049, 10))).toBe("size");
    expect(aoiGrid(ring(10, 2049))).toBe("size");
  });
});

describe("selectEntries (criterion 4)", () => {
  const aoi: Aoi = { epsg: 32617, gt: [1000, 10, 0, 2000, 0, -10], width: 50, height: 50 }; // x 1000..1500, y 1500..2000
  const e = (year: number, x0: number, y0: number, x1: number, y1: number, epsg = 32617): AefEntry => ({ year, epsg, path: `${year}/${x0}-${y0}`, x0, y0, x1, y1 });
  const index = [
    e(2021, 0, 0, 1100, 1600), // overlaps the SW corner
    e(2021, 1200, 1700, 1300, 1800), // inside
    e(2021, 1500, 1500, 3000, 3000), // touches the east edge only
    e(2021, 0, 2000, 3000, 3000), // touches the north edge only
    e(2021, 1500, 2000, 1600, 2100), // touches the NE corner only
    e(2020, 1200, 1700, 1300, 1800), // other year
    e(2021, 0, 0, 3000, 3000), // covers the AOI
  ];
  it("returns exactly the year's entries that overlap with positive area", () => {
    expect(selectEntries(index, aoi, 2021)).toEqual([index[0], index[1], index[6]]);
    expect(selectEntries(index, aoi, 2020)).toEqual([index[5]]);
    expect(selectEntries(index, aoi, 2019)).toEqual([]);
  });
});

describe("aoiGrid input (F6)", () => {
  it.each([
    ["an empty ring", []],
    ["a NaN longitude", [[NaN, 10], [1, 10], [1, 11]]],
    ["a NaN latitude", [[0, 10], [1, NaN], [1, 11]]],
    ["an infinite coordinate", [[0, 10], [Infinity, 10], [1, 11]]],
  ] as [string, [number, number][]][])("throws on %s instead of reporting zones", (_name, ring) => {
    expect(() => aoiGrid(ring)).toThrow("aoiGrid needs a ring of finite lon/lat vertices");
  });
});

describe("sameAoi (tester F7)", () => {
  const a: Aoi = { epsg: 32617, gt: [500000, 10, 0, 2800000, 0, -10], width: 128, height: 64 };
  it("is true for an equal grid, even as another object", () => expect(sameAoi(a, { ...a, gt: [...a.gt] })).toBe(true));
  it.each([
    ["epsg", { ...a, epsg: 32616 }], ["width", { ...a, width: 129 }], ["height", { ...a, height: 63 }],
    ["origin", { ...a, gt: [500010, 10, 0, 2800000, 0, -10] as Aoi["gt"] }],
  ])("is false for another %s", (_n, b) => expect(sameAoi(a, b)).toBe(false));
});
