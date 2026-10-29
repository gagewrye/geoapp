import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec 013 criteria 2 (import graph) and 3 (dependencies and lint): shelf/ stays outside the app.

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|js|mjs)$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** Every module specifier: static and side-effect imports, re-exports and dynamic import(). */
const specifiers = (text: string) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

describe("shelf/ is outside the import graph (criterion 2)", () => {
  it("finds specifiers in each import form", () => {
    expect(specifiers(`import a from "x";\nimport "y";\nexport { b } from 'z';\nawait import("w");`)).toEqual(["x", "y", "z", "w"]);
  });

  it("no file under src/ or tests/ imports from shelf/, terra-draw or the AlphaEarth fixtures", () => {
    const all = [...files("src"), ...files("tests")];
    expect(all.length).toBeGreaterThan(50);
    const bad = all.flatMap((f) => specifiers(readFileSync(f, "utf8")).filter((s) => /shelf\/|terra-draw|fixtures\/aef/.test(s)).map((s) => `${f}: ${s}`));
    expect(bad).toEqual([]);
  });
});

describe("dependencies and lint (criterion 3)", () => {
  it("package.json has neither terra-draw package", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, Record<string, string> | undefined>;
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names).not.toContain("terra-draw");
    expect(names).not.toContain("terra-draw-maplibre-gl-adapter");
  });

  it("eslint.config.js ignores shelf/", () => {
    const ignores = /ignores:\s*\[([^\]]*)\]/.exec(readFileSync("eslint.config.js", "utf8"))?.[1] ?? "";
    expect(ignores).toMatch(/["']shelf\/["']/);
  });
});
