import { describe, expect, it } from "vitest";
import { buildAefPreview } from "../../../src/io/aefPreview";
import { fakeSource } from "../helpers/sources";

describe("buildAefPreview (spec 002 preview)", () => {
  // A01 = -0.3, A16 = 0, A09 = 0.3 everywhere; NaN in A16 from column 290
  const { source, reads } = fakeSource({ width: 300, height: 280, bandCount: 64, epsg: 32617, gt: [500000, 10, 0, 2800000, 0, -10] },
    (b, c) => (b === 1 ? -0.3 : b === 16 ? (c >= 290 ? NaN : 0) : b === 9 ? 0.3 : 0.9));
  const p = buildAefPreview(source, 100);

  it("keeps aefPreview's stretch: A01 -0.3 -> 0, A16 0 -> 128, A09 0.3 -> 255", async () => {
    const { rgba, width, height } = await p;
    const i = 4 * (Math.floor(height / 2) * width + Math.floor(width / 2));
    expect(Array.from(rgba.subarray(i, i + 4))).toEqual([0, 128, 255, 255]);
  });

  it("is transparent where a preview band is NaN, and reads only 256 px grid windows", async () => {
    const { rgba, width, height } = await p;
    expect(rgba[4 * (Math.floor(height / 2) * width + width - 1) + 3]).toBe(0);
    expect(reads.every((r) => r.x0 % 256 === 0 && r.y0 % 256 === 0 && r.width <= 256 && r.height <= 256)).toBe(true);
  });
});
