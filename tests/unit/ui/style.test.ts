import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("space backdrop (spec 015 criterion 4)", () => {
  it("the #map rule draws the stars with gradients, without url(", () => {
    const css = readFileSync("src/ui/style.css", "utf8");
    const rules = [...css.matchAll(/^#map\s*\{([^}]*)\}/gm)].map((m) => m[1]!);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain("radial-gradient");
    expect(rules[0]).not.toContain("url(");
  });
});
