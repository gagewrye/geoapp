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

describe("spec 035 review follow-ups (spec 036 criterion 10)", () => {
  // the README (5594d74) no longer describes Show (H) or the opacity slider, so only the style.css half remains
  it("style.css has no #status [hidden] rule", () => {
    expect(readFileSync("src/ui/style.css", "utf8")).not.toMatch(/#status\s+\[hidden\]/);
  });
});
