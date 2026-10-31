import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Spec 035 criterion 7 (scope 8): the mode and peek wiring lives in ui/modes.ts, not labels.ts.
describe("mode wiring moved out of labels.ts", () => {
  it("modes.ts exists and labels.ts defines no MODES, setMode or keyed, nor imports deferMode", () => {
    expect(existsSync("src/ui/modes.ts")).toBe(true);
    const src = readFileSync("src/ui/labels.ts", "utf8");
    expect(src).not.toMatch(/\b(const|let|var|function)\s+(MODES|setMode|keyed)\b/);
    expect(src).not.toMatch(/from\s+["'][^"']*deferMode["']/);
  });
});
