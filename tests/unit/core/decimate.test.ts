import { describe, expect, it } from "vitest";
import { decimatedTile, decimationFactor, decimateInto, decimatedAffine } from "../../../src/core/decimate";
import { applyAffine } from "../../../src/core/crs";
import { colRow, makeTile } from "../helpers/tiles";

describe("decimation", () => {
  it("chooses the smallest factor that fits maxSide", () => {
    expect(decimationFactor(1000, 500, 1000)).toBe(1);
    expect(decimationFactor(1001, 500, 1000)).toBe(2);
    expect(decimationFactor(2048, 4096, 1024)).toBe(4);
  });
  it("gives the same result window by window as from one window", () => {
    const f = 3;
    const one = decimatedTile(10, 7, f, 2, null);
    decimateInto(one, makeTile(0, 0, 10, 7, 2, colRow), f, 10, 7);
    const parts = decimatedTile(10, 7, f, 2, null);
    for (const [x0, y0, w, h] of [[0, 0, 4, 4], [4, 0, 6, 4], [0, 4, 4, 3], [4, 4, 6, 3]] as const) {
      decimateInto(parts, makeTile(x0, y0, w, h, 2, colRow), f, 10, 7);
    }
    expect(parts.width).toBe(4);
    expect(parts.height).toBe(3);
    expect(parts.bands).toEqual(one.bands);
    expect(Array.from(one.bands[0]!.subarray(0, 4))).toEqual([1, 4, 7, 9]);
  });
  it("keeps sampled pixel centres within half a pixel of decimated centres", () => {
    const gt = [100, 2, 0, 50, 0, -2] as [number, number, number, number, number, number];
    const d = decimatedAffine(gt, 4);
    const [x] = applyAffine(d, 1.5, 0);
    const [xs] = applyAffine(gt, 4 + 2 + 0.5, 0);
    expect(Math.abs(x - xs)).toBeLessThanOrEqual(1);
  });
});
