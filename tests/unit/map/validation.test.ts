import { describe, expect, it } from "vitest";
import { ringValidation } from "../../../src/map/validation";
import type { GeoJSONStoreFeatures } from "terra-draw";

const poly = (ring: number[][]) => ({ type: "Feature", properties: { mode: "polygon" }, geometry: { type: "Polygon", coordinates: [ring] } }) as unknown as GeoJSONStoreFeatures;
type Update = "provisional" | "commit" | "finish";
const ctx = (updateType: Update) => ({ updateType, project: () => ({ x: 0, y: 0 }), unproject: () => ({ lng: 0, lat: 0 }), coordinatePrecision: 9 });

describe("map ring validation", () => {
  it("rejects every update type for blocked rings and reports why", () => {
    const seen: string[] = [];
    const v = ringValidation((r) => seen.push(r));
    for (const t of ["provisional", "commit", "finish"] as const) {
      expect(v(poly([[179, 0], [-179, 0], [-179, 1], [179, 0]]), ctx(t)).valid).toBe(false);
      expect(v(poly([[0, 0], [1, 85.2], [1, 0], [0, 0]]), ctx(t)).valid).toBe(false);
    }
    expect(seen).toEqual(["antimeridian", "latitude", "antimeridian", "latitude", "antimeridian", "latitude"]);
  });
  it("accepts valid rings, and wraps world-copy longitudes before checking", () => {
    const v = ringValidation(() => { throw new Error("should not block"); });
    expect(v(poly([[10, 0], [11, 0], [11, 1], [10, 0]]), ctx("commit")).valid).toBe(true);
    expect(v(poly([[370, 0], [371, 0], [371, 1], [370, 0]]), ctx("commit")).valid).toBe(true);
    expect(ringValidation(() => {})(poly([[179.5, 0], [181, 0], [181, 1], [179.5, 0]]), ctx("commit")).valid).toBe(false);
  });
});
