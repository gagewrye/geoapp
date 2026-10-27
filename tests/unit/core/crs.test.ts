import { describe, expect, it } from "vitest";
import { crossesAntimeridian, normalizeLon, toLonLat } from "../../../src/core/crs";

// Spec 001 criterion 3 (toPixelPolygons) is superseded by spec 003 criterion 1 (pixelAt, pixel.test.ts).

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

describe("normalizeLon", () => {
  it("wraps longitudes into [-180, 180] and keeps +-180", () => {
    expect(normalizeLon(181)).toBeCloseTo(-179, 12);
    expect(normalizeLon(-540.5)).toBeCloseTo(179.5, 12);
    expect(normalizeLon(180)).toBe(180);
    expect(normalizeLon(-180)).toBe(-180);
    expect(normalizeLon(12.25)).toBe(12.25);
  });
});
