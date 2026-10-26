import { describe, expect, it } from "vitest";
import { grabsBody, translatedPastAntimeridian } from "../../../src/core/drag";

describe("grabsBody", () => {
  // 200x160 px square, closed ring, with its edge midpoints
  const ring: [number, number][] = [[0, 0], [200, 0], [200, 160], [0, 160], [0, 0]];
  const mids: [number, number][] = [[100, 0], [200, 80], [100, 160], [0, 80]];

  it("is true well inside, away from every vertex and midpoint", () => {
    expect(grabsBody(ring, mids, [100, 80], 40)).toBe(true);
  });
  it("is false within the grab distance of a vertex or a midpoint", () => {
    expect(grabsBody(ring, mids, [30, 20], 40)).toBe(false); // near vertex 0,0
    expect(grabsBody(ring, mids, [170, 80], 40)).toBe(false); // near midpoint 200,80
  });
  it("is true just beyond the grab distance", () => {
    expect(grabsBody(ring, mids, [100, 41], 40)).toBe(true);
  });
  it("is false outside the polygon", () => {
    expect(grabsBody(ring, mids, [300, 80], 40)).toBe(false);
  });
  it("accepts an open ring", () => {
    expect(grabsBody(ring.slice(0, 4), mids, [100, 80], 40)).toBe(true);
  });
});

describe("translatedPastAntimeridian", () => {
  const ring: [number, number][] = [[170, 0], [179, 0], [179, 5], [170, 0]];
  it("is false while every vertex stays within [-180, 180]", () => {
    expect(translatedPastAntimeridian(ring, 1)).toBe(false);
    expect(translatedPastAntimeridian(ring, -100)).toBe(false);
  });
  it("allows a vertex to land exactly on 180", () => {
    expect(translatedPastAntimeridian(ring, 1)).toBe(false);
  });
  it("is true once any vertex would pass 180 either way", () => {
    expect(translatedPastAntimeridian(ring, 1.5)).toBe(true);
    expect(translatedPastAntimeridian([[-175, 0], [-170, 0], [-170, 5]], -6)).toBe(true);
  });
});
