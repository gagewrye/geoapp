import { describe, expect, it } from "vitest";
import { formatLonLat, formatPixel, formatTool, formatZoom } from "../../../src/core/status";

// Spec 032 criterion 1.
describe("status formats", () => {
  it("lon/lat with N/S and E/W suffixes, absolute values, 5 decimals", () => {
    expect(formatLonLat(29.9187, 31.2041)).toBe("31.20410 N 29.91870 E");
    expect(formatLonLat(-0.5, -12)).toBe("12.00000 S 0.50000 W");
  });

  it("the tool from mode, class and brush side", () => {
    expect(formatTool("paint", "Water", 7)).toBe("Paint · Water · 7 px");
    expect(formatTool("pan", "Water", 7)).toBe("Pan · Water · 7 px");
    expect(formatTool("erase", "Water", 7)).toBe("Erase · Water · 7 px"); // spec 033 scope 6
    expect(formatTool("smart", "Water", 7)).toBe("Smart · Water"); // spec 046 scope 8: no brush
    expect(formatTool("smart", "Water", 7, true)).toBe("Smart · Water · reading…");
    // spec 054 criterion 9: no brush either
    expect(formatTool("fill", "Water", 7)).toBe("Fill · Water");
    expect(formatTool("fill", "Water", 7, true)).toBe("Fill · Water · reading…");
    expect(formatTool("polygon", "Water", 7)).toBe("Polygon · Water");
  });

  it("the pixel only on the raster, and the zoom to one decimal", () => {
    const dims = { width: 1000, height: 700 };
    expect(formatPixel(dims, [5, 699])).toBe("px 5, 699");
    for (const p of [[-1, 0], [0, -1], [1000, 0], [0, 700], [NaN, 3]] as [number, number][]) expect(formatPixel(dims, p)).toBe("");
    expect(formatZoom(17.3456)).toBe("z 17.3");
  });
});
