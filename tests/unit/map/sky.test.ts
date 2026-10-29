import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKY } from "../../../src/map/sky";
import { baseStyle } from "../../../src/map/style";

/** Alpha of an `rgba(r,g,b,a)` colour. */
const alpha = (c: string) => Number(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/.exec(c)![1]);

describe("space backdrop (spec 015)", () => {
  it("the style's sky is SKY, and its three colours are transparent (criterion 1)", () => {
    expect(baseStyle().sky).toEqual(SKY);
    for (const k of ["sky-color", "horizon-color", "fog-color"] as const) expect(alpha(SKY[k])).toBe(0);
  });

  it("the #map rule draws the stars without url( (criterion 5)", () => {
    const css = readFileSync("src/ui/style.css", "utf8");
    const rules = [...css.matchAll(/^#map\s*\{([^}]*)\}/gm)].map((m) => m[1]!);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain("radial-gradient");
    expect(rules[0]).not.toContain("url(");
  });
});
