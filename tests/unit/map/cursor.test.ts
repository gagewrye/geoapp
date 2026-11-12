import { describe, expect, it } from "vitest";
import { brushCursor, eraserCursor } from "../../../src/map/cursor";

const svgOf = (cursor: string) => decodeURIComponent(cursor.slice('url("data:image/svg+xml,'.length, cursor.indexOf('")')));

// Spec 058 criterion 3: the eraser cursor is an inline 32x32 SVG with an on-image hotspot.
describe("eraserCursor", () => {
  const c = eraserCursor();

  it("is an SVG data URL with a crosshair fallback", () => {
    expect(c.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(c.endsWith(" crosshair")).toBe(true);
  });

  it("has two integer hotspot numbers in 0..31", () => {
    const m = /"\) (\d+) (\d+), crosshair$/.exec(c);
    expect(m).not.toBeNull();
    for (const n of [Number(m![1]), Number(m![2])]) { expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(31); }
  });

  it("decodes to a 32 px SVG with no external reference", () => {
    const svg = svgOf(c);
    expect(svg).toContain('width="32"');
    expect(svg).not.toContain("href");
    expect(svg).not.toContain("url(");
  });

  it("is not the brush cursor", () => {
    expect(c).not.toBe(brushCursor("#ffffff"));
  });
});
