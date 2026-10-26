import { describe, expect, it } from "vitest";
import type { Aoi } from "../../../src/core/aef";
import { overlapWindow, pasteBand, placeCog } from "../../../src/core/mosaic";

const aoi: Aoi = { epsg: 32617, gt: [1000, 10, 0, 5000, 0, -10], width: 300, height: 300 };

describe("placeCog", () => {
  it("places a north-up COG by its top-left corner", () => {
    expect(placeCog(aoi, [1200, 10, 0, 4900, 0, -10], 50, 40)).toEqual({ col: 20, row: 10, width: 50, height: 40, bottomUp: false });
  });

  it("places a bottom-up COG by its north-up top-left corner", () => {
    // south edge at 4500, 40 rows -> north edge 4900
    expect(placeCog(aoi, [1200, 10, 0, 4500, 0, 10], 50, 40)).toEqual({ col: 20, row: 10, width: 50, height: 40, bottomUp: true });
  });

  it("allows COGs that start outside the AOI", () => {
    expect(placeCog(aoi, [-80000, 10, 0, 90000, 0, -10], 8192, 8192)).toMatchObject({ col: -8100, row: -8500 });
  });

  it.each([
    ["origin 5 m off in x", [1205, 10, 0, 4900, 0, -10]],
    ["origin 5 m off in y", [1200, 10, 0, 4895, 0, -10]],
    ["20 m pixels", [1200, 20, 0, 4900, 0, -20]],
    ["rotated", [1200, 10, 1, 4900, 0, -10]],
  ] as const)("refuses a COG with %s", (_name, gt) => {
    expect(placeCog(aoi, [...gt], 50, 40)).toBeNull();
  });
});

describe("overlapWindow", () => {
  const win = { x0: 256, y0: 0, width: 44, height: 256 };
  it("returns the file window and destination offset of the covered part", () => {
    const p = { col: 250, row: 100, width: 20, height: 30, bottomUp: false };
    expect(overlapWindow(p, win)).toEqual({ src: [6, 0, 20, 30], dx: 0, dy: 100, w: 14, h: 30, bottomUp: false });
  });

  it("counts file rows from the south for a bottom-up COG", () => {
    // AOI rows 200..256 are north-up COG rows 100..156, i.e. file rows 300-156..300-100
    const p = { col: 200, row: 100, width: 100, height: 300, bottomUp: true };
    expect(overlapWindow(p, win)).toEqual({ src: [56, 144, 100, 300], dx: 0, dy: 100, w: 44, h: 156, bottomUp: true });
  });

  it("returns null when the COG misses the window or only touches it", () => {
    expect(overlapWindow({ col: 0, row: 0, width: 256, height: 256, bottomUp: false }, win)).toBeNull();
    expect(overlapWindow({ col: 300, row: 0, width: 10, height: 10, bottomUp: false }, win)).toBeNull();
  });
});

describe("pasteBand", () => {
  it("copies rows into the window, flipping a bottom-up source", () => {
    const src = Int8Array.from([1, 2, 3, 4, 5, 6]); // 3 wide, 2 rows, row 0 = south
    const top = new Int8Array(16).fill(-128);
    pasteBand(top, 4, src, { src: [0, 0, 3, 2], dx: 1, dy: 1, w: 3, h: 2, bottomUp: true });
    expect(Array.from(top)).toEqual([-128, -128, -128, -128, -128, 4, 5, 6, -128, 1, 2, 3, -128, -128, -128, -128]);
    const down = new Int8Array(16).fill(-128);
    pasteBand(down, 4, src, { src: [0, 0, 3, 2], dx: 0, dy: 2, w: 3, h: 2, bottomUp: false });
    expect(Array.from(down.subarray(8))).toEqual([1, 2, 3, -128, 4, 5, 6, -128]);
  });
});
