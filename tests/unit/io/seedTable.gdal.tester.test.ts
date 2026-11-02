import { describe, expect, it } from "vitest";
import { importTable } from "../../../src/io/seeding";
import type { LabelSource } from "../../../src/io/labelFile";
import { GDAL_FIXTURE, gdalEscape, innerOf } from "../helpers/gdalMetadata";

// Spec 051 decision 4 and spec 047 at the io seam: GDAL-form tables go through importTable's lenient reader.

const file = (classItem: string | null, nodata: number | null) => ({ classItem, meta: { nodata } }) as unknown as LabelSource;

describe("importTable on GDAL-form items (spec 051)", () => {
  it("gives the skip 'JSON is not valid JSON' for text bad after both passes", () => {
    const inner = innerOf(GDAL_FIXTURE);
    for (const bad of ["[{", inner.slice(0, 40), inner.replaceAll("&amp;", "&amp;amp;"), ""])
      expect(importTable(file(bad, 0)), bad).toEqual({ table: [], skipped: [{ field: "JSON", why: "is not valid JSON" }] });
  });

  it("reports an empty GDAL table as empty, not as bad JSON", () => {
    expect(importTable(file(gdalEscape("[]"), 0))).toEqual({ table: [], skipped: [{ field: "table", why: "is empty" }] });
  });

  it("reads a single-class GDAL table, and skips its entry when it equals nodata", () => {
    const t = gdalEscape(JSON.stringify([{ value: 0, name: "mangrove", colour: "#FF00FF" }]));
    expect(importTable(file(t, 255))).toEqual({ table: [{ value: 0, name: "mangrove", colour: "#ff00ff" }], skipped: [] });
    expect(importTable(file(t, 0))).toEqual({ table: [], skipped: [{ field: "[0].value", why: "is the file's nodata 0" }] });
  });

  it("applies spec 047's per-entry skips to GDAL-form entries (duplicate value, bad colour)", () => {
    const t = gdalEscape(JSON.stringify([{ value: 1, name: "a & b" }, { value: 1, name: "dup" }, { value: 2, name: "<c>", colour: "red" }]));
    expect(importTable(file(t, 0))).toEqual({
      table: [{ value: 1, name: "a & b" }, { value: 2, name: "<c>" }],
      skipped: [{ field: "[1].value", why: "duplicates 1" }, { field: "[2].colour", why: 'must be "#rrggbb"' }],
    });
  });
});
