import { describe, expect, it } from "vitest";
import { affineFromTags } from "../../../src/core/geotags";

describe("affineFromTags", () => {
  it("reads ModelTransformation, keeping a positive y scale", () => {
    const m = [10, 0, 0, 418080, 0, 10, 0, 2785280, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(affineFromTags({ ModelTransformation: m }, false)).toEqual([418080, 10, 0, 2785280, 0, 10]);
  });

  it("reads a tie point at any raster position with the pixel scale", () => {
    expect(affineFromTags({ ModelPixelScale: [30, 20, 0], ModelTiepoint: [2, 3, 0, 1000, 5000, 0] }, false)).toEqual([940, 30, 0, 5060, 0, -20]);
  });

  it("shifts a PixelIsPoint tie point from the pixel centre to its corner", () => {
    expect(affineFromTags({ ModelPixelScale: [10, 10, 0], ModelTiepoint: [0, 0, 0, 1000, 5000, 0] }, true)).toEqual([995, 10, 0, 5005, 0, -10]);
  });

  it("throws without georeferencing", () => {
    expect(() => affineFromTags({}, false)).toThrow(/georeferenc/);
  });
});
