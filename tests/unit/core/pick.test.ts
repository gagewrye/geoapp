import { describe, expect, it } from "vitest";
import { labelAt } from "../../../src/core/pick";

// Spec 038 criterion 1.
describe("labelAt", () => {
  const w = { x0: 256, y0: 512, width: 3, height: 2 };
  const tile = Uint8Array.from([1, 0, 2, 3, 0, 4]); // row-major within w

  it("reads the four corners of a 3x2 window at (256, 512)", () => {
    expect(labelAt(tile, w, 256, 512)).toBe(1);
    expect(labelAt(tile, w, 258, 512)).toBe(2);
    expect(labelAt(tile, w, 256, 513)).toBe(3);
    expect(labelAt(tile, w, 258, 513)).toBe(4);
    expect(labelAt(tile, w, 257, 513)).toBe(0);
  });

  it("throws a RangeError for a cell outside the window", () => {
    for (const [c, r] of [[255, 512], [259, 512], [256, 511], [256, 514]] as const) expect(() => labelAt(tile, w, c, r)).toThrow(RangeError);
  });
});

// Spec 038 criterion 7: the old undo helper is gone (its name is built here so this file doesn't name it).
describe("scope 6", () => {
  it("no file under src/ or tests/ names the removed undo helper", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const name = ["undo", "Edit"].join("");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : /\.(ts|mjs|js)$/.test(d.name) ? [join(dir, d.name)] : []));
    const hits = [...files("src"), ...files("tests")].filter((f) => new RegExp(`\b${name}\b`).test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
