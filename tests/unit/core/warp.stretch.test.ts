import { describe, expect, it } from "vitest";
import { warpPreview } from "../../../src/core/warp";
import type { Affine } from "../../../src/core/types";
import { makeTile } from "../helpers/tiles";

describe("warpPreview with a fixed stretch", () => {
  // UTM 10 m tile whose three bands hold 64, 128 and 192 everywhere except one nodata column
  const gt: Affine = [500000, 10, 0, 2800000, 0, -10];
  const src = makeTile(0, 0, 50, 50, 3, (k, c) => (c === 0 ? -1 : 64 * (k + 1)), -1);

  it("[0, 255] passes already stretched values through unchanged", () => {
    const out = warpPreview(src, gt, 32617, 50, [0, 255]);
    const i = 4 * (25 * out.width + 25);
    expect(Array.from(out.rgba.subarray(i, i + 4))).toEqual([64, 128, 192, 255]);
  });

  it("without it, each band is stretched over its own range (spec 001)", () => {
    const out = warpPreview(src, gt, 32617, 50);
    const i = 4 * (25 * out.width + 25);
    expect(out.rgba[i]).toBe(0); // a constant band maps to 0
  });

  it("nodata stays transparent", () => {
    const out = warpPreview(src, gt, 32617, 50, [0, 255]);
    expect(out.rgba[4 * (25 * out.width) + 3]).toBe(0);
  });
});
