// Fragment of tests/unit/core/geotags.test.ts (spec 013): its assertions on shelved functions, to merge back by hand.
import { describe, expect, it } from "vitest";
import { northUpAffine } from "../../../src/core/geotags";

describe("northUpAffine", () => {
  it("moves a bottom-up origin to the northern edge and negates the y scale", () => {
    expect(northUpAffine([418080, 10, 0, 2785280, 0, 10], 8192)).toEqual([418080, 10, 0, 2867200, 0, -10]);
  });

  it("leaves a north-up transform unchanged", () => {
    expect(northUpAffine([1, 10, 0, 5, 0, -10], 4)).toEqual([1, 10, 0, 5, 0, -10]);
  });
});
