import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("README (spec 037 criterion 9)", () => {
  // the README (5594d74) no longer describes Show, the opacity slider or Redo; only the old run-on sentence stays ruled out
  it("doesn't run the Show sentence into the opacity slider", () => {
    expect(readFileSync("README.md", "utf8")).not.toContain("shows the labels again, and the opacity slider");
  });
});

describe("docs (spec 050 criterion 8, as amended by spec 055)", () => {
  it("README says Export's folder picker opens in the imagery's folder on Chrome and Edge", () => {
    expect(readFileSync("README.md", "utf8")).toContain("On Chrome and Edge you choose a folder (the picker opens in the imagery's folder)");
  });
  it("ADR 0001's Status names ADR 0034", () => {
    const status = readFileSync("docs/adr/0001-tiled-tiff-writer.md", "utf8").split("\n").find((l) => l.startsWith("**Status:**"));
    expect(status).toContain("ADR 0034");
  });
});

describe("docs (spec 055 scope 7)", () => {
  const readme = () => readFileSync("README.md", "utf8");
  const status = (f: string) => readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("**Status:**"));
  it("README step 5 says export writes into a chosen folder, overwrites nothing until complete, and refuses the imagery", () => {
    const step = readme().split("\n").find((l) => l.startsWith("5. **Export labels**"))!;
    expect(step).toContain("choose a folder");
    expect(step).toContain("never overwritten until the new file is complete");
    expect(step).toContain("the imagery itself is refused");
  });
  it("README says the app stops reading the imported file once its copy is saved", () => {
    expect(readme()).toContain("Once that copy is saved the app stops reading the imported file");
  });
  it("ADR 0001's Status names ADR 0035, and ADR 0018's names ADR 0036", () => {
    expect(status("docs/adr/0001-tiled-tiff-writer.md")).toContain("ADR 0035");
    expect(status("docs/adr/0018-label-mask-base.md")).toContain("ADR 0036");
  });
});
