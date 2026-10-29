import { describe, expect, it } from "vitest";
import { flipRows, fileRows } from "../../../src/core/flip";

describe("north-up reads of bottom-up files", () => {
  it("fileRows: north-up rows [y0, y0 + h) of an H-row bottom-up file are file rows [H - y0 - h, H - y0)", () => {
    expect(fileRows(10, 0, 10)).toEqual([0, 10]);
    expect(fileRows(10, 0, 3)).toEqual([7, 10]);
    expect(fileRows(10, 7, 3)).toEqual([0, 3]);
  });

  it("flipRows reverses row order and keeps each row intact", () => {
    const a = Float32Array.from([1, 2, 3, 4, 5, 6]); // 3 rows of 2
    expect(Array.from(flipRows(a, 2, 3))).toEqual([5, 6, 3, 4, 1, 2]);
    expect(Array.from(a)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses a length that is not width x height", () => {
    expect(() => flipRows(new Float32Array(5), 2, 3)).toThrow();
  });
});
