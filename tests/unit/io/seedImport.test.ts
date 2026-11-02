import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { paletteColour } from "../../../src/core/classes";
import type { ClassEntry } from "../../../src/core/classTable";
import { tileWindows, type Window } from "../../../src/core/grid";
import { seedLut, sourceCells } from "../../../src/core/seed";
import type { Affine, Grid } from "../../../src/core/types";
import { LabelFileRefused, openLabelTiff, type LabelSource } from "../../../src/io/labelFile";
import { RasterRefusedError } from "../../../src/io/pipeline";
import { importLabels, importTable, type SeedOutcome } from "../../../src/io/seeding";
import { aefShapedFile, CLASS_GRID, CLASS_MAP, classFile, classItemFile, classValue, fakeLabelSource, ITEM_CLASSES, rgbClassFile, uint16ClassFile, writeFile } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";
import { effectiveTile } from "../../../src/io/maskBase";
import { seedMessage } from "../../../src/ui/messages";

// Spec 004 criteria 12 and 15 (their io part) and 13 (resampling and mask, brute force), on effective tiles (spec 014 criterion 5).

const GT: Affine = [10, 0.01, 0, 50, 0, -0.01];
const IMAGERY: Grid = { width: 1000, height: 1000, epsg: 4326, gt: GT }; // spec 001's EPSG:4326 fixture grid
/** Inside the class raster's footprint: band 2 is nodata (-9999) on one block, band 3 (Float32) NaN on another. */
const inNodata = (c: number, r: number) => c >= 400 && c < 460 && r >= 400 && r < 450;
const inNan = (c: number, r: number) => c >= 600 && c < 640 && r >= 500 && r < 540;
const value = (b: number, c: number, r: number) => (b === 1 && inNodata(c, r) ? -9999 : b === 2 && inNan(c, r) ? NaN : b === 0 ? c % 200 : b === 1 ? r % 100 : 150);
const imagery = () => fakeSource({ ...IMAGERY, nodata: -9999 }, value);
const open = async (buf: ArrayBuffer) => openLabelTiff(await fromArrayBuffer(buf));
const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };
/** The effective tile (spec 014: stored, else the mask's, else zeros), as `tile(key)` gives it. */
const at = (r: Exclude<SeedOutcome, string>, w: Window) => effectiveTile(imagery().source, r.store, r.base, w);

/** Brute force: every imagery pixel, from the whole file at once: 0 on imagery nodata or NaN, else lut[file value at its cell]. */
function expected(w: Window, lut: Uint8Array, file: Grid = CLASS_GRID, f: (c: number, r: number) => number = classValue): Uint8Array {
  const cells = sourceCells(IMAGERY, file, w);
  const out = new Uint8Array(w.width * w.height);
  for (let i = 0; i < out.length; i++) {
    const c = w.x0 + (i % w.width), r = w.y0 + Math.floor(i / w.width);
    if (inNodata(c, r) || inNan(c, r) || cells[2 * i]! < 0) continue;
    out[i] = lut[f(cells[2 * i]!, cells[2 * i + 1]!)]!;
  }
  return out;
}

describe("refusals (criterion 15, io)", () => {
  it("refuses 3-band, 16-bit and AlphaEarth-shaped files as not single-band 8-bit", async () => {
    for (const buf of [rgbClassFile(), uint16ClassFile(), aefShapedFile()]) {
      await expect(open(buf)).rejects.toBeInstanceOf(LabelFileRefused);
    }
  });

  it("applies spec 001's CRS and 180° checks", async () => {
    const g = (epsg: number, gt: Affine): Grid => ({ width: 10, height: 10, epsg, gt });
    const proj = (epsg: number) => ({ GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: epsg });
    const geog = { GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 };
    const u8 = new Uint8Array(100).fill(1);
    await expect(open(writeFile(g(2154, [700000, 10, 0, 6600000, 0, -10]), 1, u8, undefined, proj(2154)))).rejects.toSatisfy((e) => e instanceof RasterRefusedError && e.reason === "crs");
    await expect(open(writeFile(g(4326, [179.5, 0.1, 0, 10, 0, -0.1]), 1, u8, undefined, geog))).rejects.toSatisfy((e) => e instanceof RasterRefusedError && e.reason === "antimeridian");
  });

  it("reads GDAL_NODATA only when it is an integer 0..255", async () => {
    for (const [nd, want] of [["255", 255], ["0", 0], [null, null], ["-9999", null], ["3.5", null], ["nan", null]] as const) {
      expect((await open(classFile(nd))).meta.nodata).toBe(want);
    }
  });
});

describe("classes (criterion 12, io)", () => {
  it("takes names and colours from the file's CLASS_ITEM, with the LUT a valid table gave before spec 047 (spec 047 criterion 5)", async () => {
    const file = await open(await classItemFile());
    expect(file.meta.nodata).toBe(0);
    const { table, skipped } = importTable(file);
    expect(table).toEqual(ITEM_CLASSES.map((c, i) => ({ value: i + 1, ...c })));
    expect(skipped).toEqual([]);
    const r = ok(await importLabels(imagery().source, file, table));
    expect(r.classes).toEqual(ITEM_CLASSES);
    // the table lists every value, so count, windows and preview follow from the same LUT as before
    expect(Array.from(r.base.lut)).toEqual(Array.from(seedLut(table!, [1, 2, 3])));
  });

  it("values the file's table doesn't name import as Class v after it (spec 047 settled 2)", { timeout: 30_000 }, async () => {
    const file = { ...await open(classFile("255")), classItem: JSON.stringify(CLASS_MAP) };
    const r = ok(await importLabels(imagery().source, file, importTable(file).table));
    expect(r.classes).toEqual([{ name: "Seven", colour: "#123456" }, { name: "Three", colour: paletteColour(1) }, { name: "Class 0", colour: paletteColour(2) }]);
    const lut = seedLut([...CLASS_MAP, { value: 0, name: "Class 0" }], [1, 2, 3]);
    for (const w of tileWindows(1000, 1000)) expect(Buffer.from(await at(r, w)).equals(Buffer.from(expected(w, lut))), `${w.x0},${w.y0}`).toBe(true);
    expect(r.classCount).toBe(3);
  });

  it("from values gives Class 0, 3, 7, and without GDAL_NODATA 255 becomes a class too", { timeout: 30_000 }, async () => {
    expect(importTable(await open(classFile("255")))).toEqual({ table: null, skipped: [] });
    const a = ok(await importLabels(imagery().source, await open(classFile("255")), null));
    expect(a.classes.map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]);
    const b = ok(await importLabels(imagery().source, await open(classFile(null)), null));
    expect(b.classes.map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7", "Class 255"]);
    expect(b.classes.map((c) => c.colour)).toEqual([0, 1, 2, 3].map(paletteColour));
  });
});

describe("a bad class table never refuses an import (spec 047 criterion 4, fake sources)", () => {
  const G: Grid = { width: 300, height: 200, epsg: 32633, gt: [500000, 10, 0, 5000000, 0, -10] };
  const img = () => fakeSource({ ...G, bandCount: 1, nodata: null, float: false }, () => 9).source;
  /** Nodata 0 and values 1-8 in 16 px blocks, with this CLASS_ITEM text. */
  const file = (classItem: string | null): LabelSource => ({ ...fakeLabelSource(G, (c, r) => ((c >> 4) + (r >> 4)) % 8 + 1, 0).source, classItem });
  const table = (from: number) => JSON.stringify(Array.from({ length: 9 - from }, (_, i) => ({ value: from + i, name: `v${from + i}` })));

  it("a table naming the nodata value 0 imports like the same table without it, and the message names [0].value", async () => {
    const withZero = file(table(0)), without = file(table(1));
    const a = importTable(withZero), b = importTable(without);
    expect(a.skipped).toEqual([{ field: "[0].value", why: "is the file's nodata 0" }]);
    expect(b.skipped).toEqual([]);
    const ra = ok(await importLabels(img(), withZero, a.table)), rb = ok(await importLabels(img(), without, b.table));
    expect(ra.classes.map((c) => c.name)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"]);
    expect(ra.classes).toEqual(rb.classes);
    expect(ra.base.count).toBe(rb.base.count);
    expect(ra.base.count).toBe(G.width * G.height);
    expect(Array.from(ra.base.preview.values)).toEqual(Array.from(rb.base.preview.values));
    expect(seedMessage(ra, a.skipped)).toMatch(/ Ignored part of the file's class table: \[0\]\.value is the file's nodata 0\.$/);
  });

  it("a table that isn't JSON imports with Class v names", async () => {
    const f = file("{not json");
    const { table: t, skipped } = importTable(f);
    expect(skipped).toEqual([{ field: "JSON", why: "is not valid JSON" }]);
    const r = ok(await importLabels(img(), f, t));
    expect(r.classes.map((c) => c.name)).toEqual(["Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6", "Class 7", "Class 8"]);
  });

  it("a bad entry is skipped and its value gets Class v; a name it would take joins that class", async () => {
    const f = file(JSON.stringify([{ value: 1, name: "Class 2" }, { value: 2, name: "" }, { value: 3, name: "Sand", colour: "sand" }]));
    const { table: t, skipped } = importTable(f);
    expect(skipped.map((x) => x.field)).toEqual(["[1].name", "[2].colour"]);
    const r = ok(await importLabels(img(), f, t));
    expect(r.classes.map((c) => c.name)).toEqual(["Class 2", "Sand", "Class 4", "Class 5", "Class 6", "Class 7", "Class 8"]);
    expect(r.base.lut[1]).toBe(1);
    expect(r.base.lut[2]).toBe(1); // "Class 2" joins the table's class of that name
  });
});

describe("resampling and mask (criterion 13, io brute force; spec 014 criterion 5)", () => {
  const entries: ClassEntry[] = [{ value: 0, name: "Class 0" }, { value: 3, name: "Class 3" }, { value: 7, name: "Class 7" }, { value: 255, name: "Class 255" }];

  for (const nd of ["255", null]) {
    it(`each imported pixel is 0 on imagery nodata or NaN, else seedLut of the file value at its sourceCells (GDAL_NODATA ${nd ?? "unset"})`, { timeout: 60_000 }, async () => {
      const r = ok(await importLabels(imagery().source, await open(classFile(nd)), null));
      const lut = seedLut(nd ? entries.slice(0, 3) : entries, [1, 2, 3, 4]);
      let labelled = 0;
      for (const w of tileWindows(1000, 1000)) {
        const want = expected(w, lut);
        labelled += want.filter((v) => v).length;
        expect(Buffer.from(await at(r, w)).equals(Buffer.from(want)), `${w.x0},${w.y0}`).toBe(true);
      }
      expect(r.pixels).toBe(labelled);
      expect(r.store.tiles.size).toBe(0); // the file is the base; nothing is copied (spec 014)
      // without the mask, both blocks would get labels: the mask mattered
      for (const [x0, y0] of [[400, 400], [600, 500]] as const) {
        const cells = sourceCells(IMAGERY, CLASS_GRID, { x0, y0, width: 40, height: 40 });
        const unmasked = Array.from({ length: 1600 }, (_, i) => (cells[2 * i]! < 0 ? 0 : lut[classValue(cells[2 * i]!, cells[2 * i + 1]!)]!));
        expect(unmasked.filter((v) => v).length).toBeGreaterThan(100);
      }
    });
  }
});

describe("stale runs (spec 003's rule for replaced rasters)", () => {
  it("stops and returns \"stale\" once another raster opened", async () => {
    let calls = 0;
    const file: LabelSource = await open(classFile("255"));
    expect(await importLabels(imagery().source, file, null, () => ++calls > 2)).toBe("stale");
  });
});
