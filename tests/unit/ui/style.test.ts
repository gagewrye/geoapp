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
  it("the README names Show (H) and the opacity slider beside it, and style.css has no #status [hidden] rule", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("clear **Show** (H)");
    expect(readme).toContain("the opacity slider beside it");
    expect(readFileSync("src/ui/style.css", "utf8")).not.toMatch(/#status\s+\[hidden\]/);
  });
});
