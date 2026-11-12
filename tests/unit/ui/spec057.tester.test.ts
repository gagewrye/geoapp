import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec 057 criteria 5 and 8 (tester): guards that grep alone would otherwise carry
describe("spec 057 (tester)", () => {
  it("no file in tests/e2e/ presses Control+z, so undo presses work on macOS (criterion 5)", () => {
    const files = readdirSync("tests/e2e", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join("tests/e2e", f), "utf8"), f).not.toContain('"Control+z"');
  });

  it("specs 036, 037, 039, 046 and 050 each carry an 'Amended by spec 057' note (criterion 8)", () => {
    const specs = readdirSync("docs/specs");
    for (const n of ["036", "037", "039", "046", "050"]) {
      const file = specs.find((f) => f.startsWith(`${n}-`));
      expect(file, n).toBeDefined();
      expect(readFileSync(join("docs/specs", file!), "utf8"), n).toMatch(/\*\*Amended by spec 057 \(2026-11-11\):\*\*/);
    }
  });

  it("the README notes for 036, 037 and 050 say the README no longer has to hold that wording (criterion 8)", () => {
    for (const f of ["036-class-palette.md", "037-redo.md", "050-save-in-imagery-folder.md"]) {
      const note = readFileSync(join("docs/specs", f), "utf8").split("\n").find((l) => l.includes("Amended by spec 057"))!;
      expect(note, f).toMatch(/no longer requires the README/);
    }
  });
});
