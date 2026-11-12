import { describe, expect, it } from "vitest";
import { brushCursor, eraserCursor } from "../../../src/map/cursor";

const svgOf = (cursor: string) => decodeURIComponent(cursor.slice('url("data:image/svg+xml,'.length, cursor.indexOf('")')));

// Spec 058 criterion 3 and questions 3 and 6, tester's extra checks.
describe("eraserCursor, tester", () => {
  const c = eraserCursor(), svg = svgOf(c);

  it("is the same string on every call (the brush skips setProperty when unchanged)", () => {
    expect(eraserCursor()).toBe(c);
  });

  it("hotspot is about 6 26 (the middle of the tip's bottom edge)", () => {
    const m = /"\) (\d+) (\d+), crosshair$/.exec(c)!;
    expect(Math.abs(Number(m[1]) - 6)).toBeLessThanOrEqual(2);
    expect(Math.abs(Number(m[2]) - 26)).toBeLessThanOrEqual(2);
  });

  it("is 32x32 by height too, and its data URL has no raw quote, space or # to break the CSS", () => {
    expect(svg).toContain('height="32"');
    const data = c.slice('url("data:image/svg+xml,'.length, c.indexOf('")'));
    expect(data).not.toMatch(/["\s#]/);
  });

  it("has the pink tip, a white sleeve and halo, and a black 1.2 px outline (question 6)", () => {
    expect(svg).toContain("#f28fa5");
    expect(svg).toMatch(/stroke="#fff" stroke-width="3"/);
    expect(svg).toMatch(/stroke="#000" stroke-width="1.2"/);
  });

  it("has no script or event handler", () => {
    expect(svg).not.toMatch(/<script|on\w+=/i);
  });

  it("does not depend on the class colour: it differs from every brush cursor", () => {
    for (const col of ["#ff0000", "#f28fa5", "#ffffff", "#000000"]) expect(c).not.toBe(brushCursor(col));
  });
});
