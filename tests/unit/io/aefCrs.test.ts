import { describe, expect, it } from "vitest";
import { AefCrsError } from "../../../src/io/aefDownload";

describe("AefCrsError wording", () => {
  it.each([0, 32767])("EPSG code %d (missing or user-defined) reads as an unknown CRS", (epsg) => {
    expect(new AefCrsError("2021/17N/x.tiff", epsg, 32617).message)
      .toBe("AlphaEarth file 2021/17N/x.tiff is in an unknown CRS, not the area's EPSG:32617.");
  });

  it("a real code is named", () => {
    expect(new AefCrsError("x.tiff", 32618, 32617).message).toBe("AlphaEarth file x.tiff is in EPSG:32618, not the area's EPSG:32617.");
  });
});
