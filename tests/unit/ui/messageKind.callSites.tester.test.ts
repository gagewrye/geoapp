import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Tester, spec 032 criterion 2: messageKind.test.ts passes "error" itself, so this checks the app's own call sites do.
// Every say(...) in src/ui that says a scope 3 error message passes the "error" kind.
const ERRORS = /MESSAGES\.(labelFile|classTable|className|labelLimit|editLimit|maskGone|imageryUnreadable|largeBlocks|rasterAntimeridian|tooMany)\b|errorText\(|readErrorMessage\(|\berror\(e\)/;
const dir = join(process.cwd(), "src", "ui");

describe("error call sites (tester, spec 032 criterion 2)", () => {
  it("each say() of a scope 3 error message passes \"error\"", () => {
    const bad: string[] = [];
    let found = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "messages.ts")) {
      readFileSync(join(dir, f), "utf8").split(/\r?\n/).forEach((line, i) => {
        if (!/\bsay\(/.test(line) || !ERRORS.test(line)) return;
        found++;
        if (!/"error"/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toBeGreaterThanOrEqual(7);
    expect(bad).toEqual([]);
  });

  it("largeBlocks, said with Raster opened., is an error", () => {
    const main = readFileSync(join(dir, "main.ts"), "utf8");
    expect(main).toMatch(/say\(off \? `Raster opened\. \$\{off\}` : "Raster opened\.", off \? "error" : "info"\)/);
  });
});
