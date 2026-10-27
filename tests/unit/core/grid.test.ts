import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";

describe("tile grid", () => {
  it("covers the raster with row-major 256x256 windows clipped at edges", () => {
    const w = tileWindows(600, 300);
    expect(w.map((t) => [t.x0, t.y0, t.width, t.height])).toEqual([
      [0, 0, 256, 256], [256, 0, 256, 256], [512, 0, 88, 256],
      [0, 256, 256, 44], [256, 256, 256, 44], [512, 256, 88, 44],
    ]);
  });
});
