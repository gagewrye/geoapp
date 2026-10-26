import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/crs-points.json";
import { crossesAntimeridian, toLonLat } from "../../../src/core/crs";
import { toPixelPolygons } from "../../../src/core/polygons";
import type { Affine } from "../../../src/core/types";

type Feature = GeoJSON.Feature<GeoJSON.Polygon, { label: number }>;
const poly = (ring: [number, number][], label = 0): Feature => ({
  type: "Feature", properties: { label }, geometry: { type: "Polygon", coordinates: [ring] },
});

describe("toPixelPolygons (criterion 3)", () => {
  for (const c of fixture.cases) {
    it(`maps reference points for EPSG:${c.epsg} within 0.01 px`, () => {
      const ring = c.points.map((p) => p.lonlat as [number, number]);
      const [out] = toPixelPolygons([poly(ring, 3)], c.epsg, c.gt as Affine);
      expect(out!.label).toBe(3);
      c.points.forEach((p, i) => {
        const [col, row] = out!.rings[0]![i]!;
        expect(Math.abs(col - p.pixel[0]!)).toBeLessThan(0.01);
        expect(Math.abs(row - p.pixel[1]!)).toBeLessThan(0.01);
      });
    });
  }
  it("keeps hole rings", () => {
    const f: Feature = { type: "Feature", properties: { label: 1 }, geometry: { type: "Polygon",
      coordinates: [[[0, 0], [4, 0], [4, -4], [0, 0]], [[1, -1], [2, -1], [2, -2], [1, -1]]] } };
    const [out] = toPixelPolygons([f], 4326, [0, 1, 0, 0, 0, -1]);
    expect(out!.rings).toHaveLength(2);
    expect(out!.rings[1]![2]).toEqual([2, 2]);
  });
  it("throws on an unsupported EPSG code", () => {
    expect(() => toPixelPolygons([poly([[0, 0], [1, 0], [1, 1]])], 2154, [0, 1, 0, 0, 0, -1])).toThrow(/EPSG:2154/);
    expect(() => toPixelPolygons([], 32661, [0, 1, 0, 0, 0, -1])).toThrow(/unsupported/i);
  });
});

describe("crossesAntimeridian (criterion 16)", () => {
  it("refuses EPSG:4326 extents past 180 either way", () => {
    expect(crossesAntimeridian(4326, [179, 0.01, 0, 10, 0, -0.01], 200, 100)).toBe(true);
    expect(crossesAntimeridian(4326, [-181, 0.01, 0, 10, 0, -0.01], 200, 100)).toBe(true);
  });
  it("allows an EPSG:4326 edge exactly at 180", () => {
    expect(crossesAntimeridian(4326, [179, 0.001, 0, 10, 0, -0.001], 1000, 100)).toBe(false);
    expect(crossesAntimeridian(4326, [-180, 0.1, 0, 90, 0, -0.1], 3600, 1800)).toBe(false);
  });
  it("refuses EPSG:3857 extents past the world edge", () => {
    expect(crossesAntimeridian(3857, [20000000, 100, 0, 0, 0, -100], 1000, 10)).toBe(true);
    expect(crossesAntimeridian(3857, [19000000, 100, 0, 0, 0, -100], 1000, 10)).toBe(false);
  });
  it("never refuses UTM", () => {
    expect(crossesAntimeridian(32660, [700000, 30, 0, 1200000, 0, -30], 5000, 100)).toBe(false);
  });
});

describe("toLonLat", () => {
  it("unwraps UTM zone 60 longitudes past 180 around the zone meridian", () => {
    const [lon] = toLonLat(32660, 828928.7360586878, 1106908.8542431425);
    expect(lon).toBeCloseTo(180, 6);
    const [lon2] = toLonLat(32660, 840000, 1106908);
    expect(lon2).toBeGreaterThan(180);
  });
});
