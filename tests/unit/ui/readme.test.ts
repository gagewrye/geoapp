import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("README (spec 037 criterion 9)", () => {
  // as amended by spec 057: the README no longer has to name Redo
  it("splits the Show sentence before the opacity slider", () => {
    expect(readFileSync("README.md", "utf8")).not.toContain("shows the labels again, and the opacity slider");
  });
});

describe("docs (spec 050 criterion 8)", () => {
  // as amended by spec 057: the README no longer has to describe the Save dialog
  it("ADR 0001's Status names ADR 0034", () => {
    const status = readFileSync("docs/adr/0001-tiled-tiff-writer.md", "utf8").split("\n").find((l) => l.startsWith("**Status:**"));
    expect(status).toContain("ADR 0034");
  });
});

describe("README (spec 058 criterion 9)", () => {
  it("step 2 says Erase removes any label", () => {
    expect(readFileSync("README.md", "utf8")).toContain("**Erase** (`E`) removes any label under the brush.");
  });
});
