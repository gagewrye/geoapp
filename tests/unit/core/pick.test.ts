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

