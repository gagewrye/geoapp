// Fragment of tests/unit/core/classes.test.ts (spec 013): its assertions on shelved functions, to merge back by hand.
import { describe, expect, it } from "vitest";
import { badClassName } from "../../../src/core/classes";

describe("label classes (spec 003 Classes)", () => {
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
