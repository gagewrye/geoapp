import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

// Spec 031 criterion 14: the worktree Vite cache (.vite/) isn't linted.
describe("eslint ignores", () => {
  it("a file under .vite/ with a lint error is ignored, and one under src/ isn't", async () => {
    const eslint = new ESLint();
    expect(await eslint.isPathIgnored(".vite/deps/chunk-x.js")).toBe(true);
    const [r] = await eslint.lintText("var unused = 1;\n", { filePath: ".vite/deps/chunk-x.js", warnIgnored: false });
    expect(r === undefined || r.messages.length === 0).toBe(true);
    expect(await eslint.isPathIgnored("src/core/x.ts")).toBe(false);
  });
});
