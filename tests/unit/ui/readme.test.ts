import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("README (spec 037 criterion 9)", () => {
  it("splits the Show sentence before the opacity slider, and names Redo", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).not.toContain("shows the labels again, and the opacity slider");
    expect(readme).toContain("**Redo**");
  });
});
