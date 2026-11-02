import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("README (spec 037 criterion 9)", () => {
  it("splits the Show sentence before the opacity slider, and names Redo", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).not.toContain("shows the labels again, and the opacity slider");
    expect(readme).toContain("**Redo**");
  });
});

describe("docs (spec 050 criterion 8)", () => {
  it("README says the Save dialog opens in the imagery's folder on Chrome and Edge", () => {
    expect(readFileSync("README.md", "utf8")).toContain("On Chrome and Edge the Save dialog opens in the imagery's folder");
  });
  it("ADR 0001's Status names ADR 0034", () => {
    const status = readFileSync("docs/adr/0001-tiled-tiff-writer.md", "utf8").split("\n").find((l) => l.startsWith("**Status:**"));
    expect(status).toContain("ADR 0034");
  });
});
