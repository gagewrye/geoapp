import { describe, expect, it } from "vitest";
import { labelFeatures } from "../../../src/core/labels";

const f = (className: string | undefined, ring: number[][]) => ({
  type: "Feature" as const, id: Math.random().toString(), properties: { className },
  geometry: { type: "Polygon" as const, coordinates: [ring] },
});

describe("labelFeatures", () => {
  it("numbers classes in order of first use and wraps longitudes", () => {
    const { classes, features } = labelFeatures([
      f("water", [[181, 0], [182, 0], [182, 1], [181, 0]]),
      f("forest", [[0, 0], [1, 0], [1, 1], [0, 0]]),
      f(" water ", [[2, 0], [3, 0], [3, 1], [2, 0]]),
    ]);
    expect(classes).toEqual(["water", "forest"]);
    expect(features.map((x) => x.properties.label)).toEqual([0, 1, 0]);
    expect(features[0]!.geometry.coordinates[0]![0]![0]).toBeCloseTo(-179, 12);
  });
  it("skips unnamed polygons and non-polygons", () => {
    const { classes, features } = labelFeatures([
      f("", [[0, 0], [1, 0], [1, 1], [0, 0]]),
      { type: "Feature", properties: { className: "x" }, geometry: { type: "Point", coordinates: [0, 0] } },
    ]);
    expect(classes).toEqual([]);
    expect(features).toEqual([]);
  });
});
