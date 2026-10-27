import { describe, expect, it } from "vitest";
import { MAX_CLASSES, PALETTE, badClassName, checkName, initialClasses, nextClass } from "../../../src/core/classes";

describe("label classes (spec 003 Classes)", () => {
  it("starts as Class 1 and Class 2 with the first palette colours", () => {
    expect(initialClasses()).toEqual([{ name: "Class 1", colour: PALETTE[0] }, { name: "Class 2", colour: PALETTE[1] }]);
  });

  it("has a fixed palette of 10 #rrggbb colours", () => {
    expect(PALETTE).toHaveLength(10);
    for (const c of PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(PALETTE).size).toBe(10);
  });

  it("adds classes cycling through the palette by position, with an unused name", () => {
    const list = initialClasses();
    while (list.length < 12) list.push(nextClass(list));
    expect(list[2]).toEqual({ name: "Class 3", colour: PALETTE[2] });
    expect(list[10]!.colour).toBe(PALETTE[0]);
    expect(list[11]!.colour).toBe(PALETTE[1]);
    const renamed = [{ name: "Class 3", colour: PALETTE[0] }, { name: "x", colour: PALETTE[1] }];
    expect(nextClass(renamed).name).toBe("Class 4");
    expect(MAX_CLASSES).toBe(255);
  });

  it("refuses empty and duplicate names and accepts others, trimmed", () => {
    const list = initialClasses();
    expect(checkName(list, 0, "")).toBeNull();
    expect(checkName(list, 0, "   ")).toBeNull();
    expect(checkName(list, 0, "Class 2")).toBeNull();
    expect(checkName(list, 0, " Class 2 ")).toBeNull();
    expect(checkName(list, 0, "Class 1")).toBe("Class 1");
    expect(checkName(list, 1, "  Mangrove & <salt> ")).toBe("Mangrove & <salt>");
  });

  it("badClassName gives the first name spec 003's rule refuses as it stands, else null (spec 004, model classes)", () => {
    expect(badClassName(["a", "b", "Mangrove & <salt>"])).toBeNull();
    expect(badClassName(["a", " padded "])).toBe(1);
    expect(badClassName(["a", "b "])).toBe(1);
    expect(badClassName(["", "b"])).toBe(0);
    expect(badClassName(["a", "   "])).toBe(1);
    expect(badClassName(["a", "b", "a"])).toBe(0);
    expect(badClassName([])).toBeNull();
  });
});
