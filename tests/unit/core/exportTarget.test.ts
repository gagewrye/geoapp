import { describe, expect, it } from "vitest";
import { exportName, targetAction } from "../../../src/core/exportTarget";

// Spec 055 criterion 1.
describe("exportName", () => {
  it("adds a missing .tif, keeps the user's case and trims", () => {
    expect(exportName("a")).toBe("a.tif");
    expect(exportName("a.TIF")).toBe("a.TIF");
    expect(exportName(" b.tif ")).toBe("b.tif");
    expect(exportName("labels_merged.tif")).toBe("labels_merged.tif");
    expect(exportName("x.tiff")).toBe("x.tiff");
  });

  it("refuses empty names, path separators, characters Windows refuses and reserved names", () => {
    for (const bad of ["", "   ", "x/y", "x\\y", "a:b", "con", "CON.tif", "lpt1", "a?b", "a*b", "a\"b", "a<b", "a|b", "a\u0001b", "a.", "x".repeat(260)]) {
      expect(exportName(bad), JSON.stringify(bad)).toBe(null);
    }
  });
});

describe("targetAction", () => {
  it("covers all 16 combinations in scope 3's order", () => {
    for (let i = 0; i < 16; i++) {
      const t = { exists: !!(i & 1), imagery: !!(i & 2), mask: !!(i & 4), maskCopied: !!(i & 8) };
      const want = !t.exists ? "write" : t.imagery ? "refuse-imagery" : t.mask && !t.maskCopied ? "refuse-mask" : "replace";
      expect(targetAction(t), JSON.stringify(t)).toBe(want);
    }
    expect(targetAction({ exists: true, imagery: false, mask: true, maskCopied: true })).toBe("replace");
    expect(targetAction({ exists: true, imagery: true, mask: true, maskCopied: false })).toBe("refuse-imagery");
    expect(targetAction({ exists: false, imagery: true, mask: true, maskCopied: false })).toBe("write");
  });
});
