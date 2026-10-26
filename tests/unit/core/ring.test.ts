import { describe, expect, it } from "vitest";
import { checkRing, normalizeLon } from "../../../src/core/ring";
import { MAX_LAT } from "../../../src/core/types";

describe("checkRing (criterion 13)", () => {
  it("flags an edge from 179 to -179", () => {
    expect(checkRing([[179, 0], [-179, 0], [-179, 1], [179, 0]])).toBe("antimeridian");
  });
  it("flags an open ring whose closing edge crosses 180", () => {
    expect(checkRing([[-179, 0], [-179, 1], [179, 1]])).toBe("antimeridian");
  });
  it("flags an edge from -100 to 100", () => {
    expect(checkRing([[-100, 0], [100, 0], [100, 10]])).toBe("antimeridian");
  });
  it("flags vertices beyond MAX_LAT north and south", () => {
    expect(checkRing([[0, 0], [1, 85.1], [2, 0]])).toBe("latitude");
    expect(checkRing([[0, 0], [1, -85.1], [2, 0]])).toBe("latitude");
  });
  it("prefers antimeridian when both apply", () => {
    expect(checkRing([[179, 85.1], [-179, 0], [0, 0]])).toBe("antimeridian");
  });
  it("accepts edges of exactly 180 degrees and vertices at exactly +-MAX_LAT", () => {
    expect(checkRing([[-90, MAX_LAT], [90, MAX_LAT], [90, -MAX_LAT], [-90, -MAX_LAT], [-90, MAX_LAT]])).toBeNull();
    expect(checkRing([[-180, 0], [0, 10], [0, 0]])).toBeNull();
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
  it("lets checkRing see a world-copy ring crossing 180", () => {
    expect(checkRing([[179.5, 0], [181, 0], [181, 1]].map(([x, y]) => [normalizeLon(x!), y!] as [number, number]))).toBe("antimeridian");
  });
});
