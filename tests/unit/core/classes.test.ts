import { describe, expect, it } from "vitest";
import { MAX_CLASSES, PALETTE, checkName, coverValues, initialClasses, nextClass } from "../../../src/core/classes";

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
});

describe("coverValues (open question 3)", () => {
  it("extends the list with Class v up to the highest value, and leaves a list that covers them alone", () => {
    const list = initialClasses();
    expect(coverValues(list, [1, 2])).toBe(list);
    const out = coverValues(list, [2, 4]);
    expect(out.map((c) => c.name)).toEqual(["Class 1", "Class 2", "Class 3", "Class 4"]);
    expect(out.slice(0, 2)).toEqual(list);
    expect(new Set(out.map((c) => c.colour)).size).toBe(4);
  });

  it("names a class by the next free name when Class v is taken", () => {
    const out = coverValues([{ name: "Class 3", colour: "#000000" }], [3]);
    expect(out.map((c) => c.name)).toEqual(["Class 3", "Class 2", "Class 4"]);
  });
});
