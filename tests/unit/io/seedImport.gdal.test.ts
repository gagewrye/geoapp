import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { paletteColour } from "../../../src/core/classes";
import { encodeClasses } from "../../../src/core/classTable";
import { openLabelTiff } from "../../../src/io/labelFile";
import { importLabels, importTable, type SeedOutcome } from "../../../src/io/seeding";
import { GDAL_FIXTURE, GDAL_TABLE } from "../helpers/gdalMetadata";
import { CLASS_GRID, metadataFile } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Spec 051 criterion 5: a GDAL-written class table imports like the app's own.

const imagery = () => fakeSource({ width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01], nodata: null }, () => 9).source;
/** Nodata 0, then values 1 and 2, in 24 x 20 px blocks. */
const value = (c: number, r: number) => (Math.floor(c / 24) + Math.floor(r / 20)) % 3;
const open = async (metadata: string) => openLabelTiff(await fromArrayBuffer(await metadataFile(value, metadata)));
const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };

describe("a GDAL-written class table (spec 051 criterion 5)", () => {
  it("imports with the fixture's names and colours, like the same table written by the app", { timeout: 30_000 }, async () => {
    const gdal = await open(GDAL_FIXTURE);
    expect(gdal.meta.nodata).toBe(0);
    expect(gdal.meta.width).toBe(CLASS_GRID.width);
    expect(importTable(gdal)).toEqual({ table: GDAL_TABLE, skipped: [] });
    const app = await open(encodeClasses([{ name: "mangrove", colour: "#1f77b4" }, { name: "A & <B> it's", colour: paletteColour(1) }]));
    const a = ok(await importLabels(imagery(), gdal, importTable(gdal).table));
    const b = ok(await importLabels(imagery(), app, importTable(app).table));
    expect(a.classes).toEqual([{ name: "mangrove", colour: "#1f77b4" }, { name: "A & <B> it's", colour: paletteColour(1) }]);
    expect(a.classes).toEqual(b.classes);
    expect(a.base.count).toBe(b.base.count);
    expect(a.base.count).toBeGreaterThan(0);
    expect(Array.from(a.base.preview.values)).toEqual(Array.from(b.base.preview.values));
  });
});
