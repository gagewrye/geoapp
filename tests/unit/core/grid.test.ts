import { describe, expect, it } from "vitest";
import { tileWindows, windowsIntersecting } from "../../../src/core/grid";

describe("tile grid", () => {
  it("covers the raster with row-major 256x256 windows clipped at edges", () => {
    const w = tileWindows(600, 300);
    expect(w.map((t) => [t.x0, t.y0, t.width, t.height])).toEqual([
      [0, 0, 256, 256], [256, 0, 256, 256], [512, 0, 88, 256],
      [0, 256, 256, 44], [256, 256, 256, 44], [512, 256, 88, 44],
    ]);
  });
  it("keeps only windows touching a bbox, clipped to the raster", () => {
    const w = windowsIntersecting(600, 300, [[250, 10, 260, 20], [-50, 290, 10, 400], [700, 0, 800, 10]]);
    expect(w.map((t) => [t.x0, t.y0])).toEqual([[0, 0], [256, 0], [0, 256]]);
  });
  it("treats a bbox ending exactly on a window edge as not touching the next window", () => {
    expect(windowsIntersecting(600, 300, [[10, 10, 256, 20]]).map((t) => t.x0)).toEqual([0]);
  });
});
