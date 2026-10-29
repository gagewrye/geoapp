// Copy of tests/unit/io/seedImport.test.ts before spec 013, for its seedModel tests and the AlphaEarth fixture refusal; the kept file holds the rest.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { initialClasses, paletteColour } from "../../../src/core/classes";
import { ClassTableError, type ClassEntry } from "../../../src/core/classTable";
import { tileWindows, type Window } from "../../../src/core/grid";
import { emptyStore } from "../../../src/core/labelStore";
import { seedFromModel } from "../../../src/core/predict";
import { seedLut, sourceCells } from "../../../src/core/seed";
import type { Affine, Grid, Model } from "../../../src/core/types";
import { LabelFileRefused, openLabelTiff, type LabelSource } from "../../../src/io/labelFile";
import { RasterRefusedError } from "../../../src/io/pipeline";
import { importLabels, importTable, seedModel, type SeedOutcome } from "../../../src/io/seeding";
import { CLASS_GRID, CLASS_MAP, classFile, classItemFile, classValue, ITEM_CLASSES, rgbClassFile, uint16ClassFile, writeFile } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Spec 004 criteria 12 and 15 (their io part) and 13 (resampling and mask, brute force).

const GT: Affine = [10, 0.01, 0, 50, 0, -0.01];
const IMAGERY: Grid = { width: 1000, height: 1000, epsg: 4326, gt: GT }; // spec 001's EPSG:4326 fixture grid
/** Inside the class raster's footprint: band 2 is nodata (-9999) on one block, band 3 (Float32) NaN on another. */
const inNodata = (c: number, r: number) => c >= 400 && c < 460 && r >= 400 && r < 450;
const inNan = (c: number, r: number) => c >= 600 && c < 640 && r >= 500 && r < 540;
const value = (b: number, c: number, r: number) => (b === 1 && inNodata(c, r) ? -9999 : b === 2 && inNan(c, r) ? NaN : b === 0 ? c % 200 : b === 1 ? r % 100 : 150);
const imagery = () => fakeSource({ ...IMAGERY, nodata: -9999 }, value);
const open = async (buf: ArrayBuffer) => openLabelTiff(await fromArrayBuffer(buf));
const fresh = () => ({ store: emptyStore(1000, 1000), classes: initialClasses() });
const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };
const at = (store: { tiles: Map<string, Uint8Array> }, w: Window) => store.tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height);

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
  it("refuses 3-band, 16-bit and AlphaEarth files as not single-band 8-bit", async () => {
    const aef = readFileSync("tests/fixtures/aef/cogs/2021/17N/fixture-west-bottomup.tiff");
    for (const buf of [rgbClassFile(), uint16ClassFile(), aef.buffer.slice(aef.byteOffset, aef.byteOffset + aef.byteLength) as ArrayBuffer]) {
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
  it("takes names and colours from the file's CLASS_ITEM", async () => {
    const file = await open(await classItemFile());
    expect(file.meta.nodata).toBe(0);
    expect(importTable(file)).toEqual(ITEM_CLASSES.map((c, i) => ({ value: i + 1, ...c })));
    const r = ok(await importLabels(imagery().source, file, importTable(file), fresh(), "replace"));
    expect(r.classes).toEqual(ITEM_CLASSES);
  });

  it("with a class map takes the map's names, and its unlisted values stay unlabelled", { timeout: 30_000 }, async () => {
    const file = await open(classFile("255"));
    const table = importTable(file, JSON.stringify(CLASS_MAP))!;
    expect(table).toEqual(CLASS_MAP);
    const r = ok(await importLabels(imagery().source, file, table, fresh(), "replace"));
    expect(r.classes).toEqual([{ name: "Seven", colour: "#123456" }, { name: "Three", colour: paletteColour(1) }]);
    const lut = seedLut(table, [1, 2]); // 0 and 255 unlisted
    for (const w of tileWindows(1000, 1000)) expect(Buffer.from(at(r.store, w)).equals(Buffer.from(expected(w, lut))), `${w.x0},${w.y0}`).toBe(true);
    expect(r.classCount).toBe(2);
  });

  it("from values gives Class 0, 3, 7, and without GDAL_NODATA 255 becomes a class too", { timeout: 30_000 }, async () => {
    expect(importTable(await open(classFile("255")))).toBeNull();
    const a = ok(await importLabels(imagery().source, await open(classFile("255")), null, fresh(), "replace"));
    expect(a.classes.map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]);
    const b = ok(await importLabels(imagery().source, await open(classFile(null)), null, fresh(), "replace"));
    expect(b.classes.map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7", "Class 255"]);
    expect(b.classes.map((c) => c.colour)).toEqual([0, 1, 2, 3].map(paletteColour));
  });

  it("an invalid class map or class item throws ClassTableError naming the field", async () => {
    const file = await open(classFile("255"));
    const field = (f: () => unknown) => { try { f(); } catch (e) { return (e as ClassTableError).field; } return null; };
    expect(field(() => importTable(file, JSON.stringify([{ value: 255, name: "x" }])))).toBe("[0].value");
    expect(field(() => importTable(file, "{not json"))).toBe("JSON");
    expect(field(() => importTable({ ...file, classItem: "[{&quot;value&quot;: 1}]" }))).toBe("[0].name");
  });
});

describe("resampling and mask (criterion 13, io brute force)", () => {
  const entries: ClassEntry[] = [{ value: 0, name: "Class 0" }, { value: 3, name: "Class 3" }, { value: 7, name: "Class 7" }, { value: 255, name: "Class 255" }];

  for (const nd of ["255", null]) {
    it(`each imported pixel is 0 on imagery nodata or NaN, else seedLut of the file value at its sourceCells (GDAL_NODATA ${nd ?? "unset"})`, { timeout: 60_000 }, async () => {
      const r = ok(await importLabels(imagery().source, await open(classFile(nd)), null, fresh(), "replace"));
      const lut = seedLut(nd ? entries.slice(0, 3) : entries, [1, 2, 3, 4]);
      let labelled = 0;
      for (const w of tileWindows(1000, 1000)) {
        const want = expected(w, lut);
        labelled += want.filter((v) => v).length;
        expect(Buffer.from(at(r.store, w)).equals(Buffer.from(want)), `${w.x0},${w.y0}`).toBe(true);
      }
      expect(r.pixels).toBe(labelled);
      // without the mask, both blocks would get labels: the mask mattered
      for (const [x0, y0] of [[400, 400], [600, 500]] as const) {
        const cells = sourceCells(IMAGERY, CLASS_GRID, { x0, y0, width: 40, height: 40 });
        const unmasked = Array.from({ length: 1600 }, (_, i) => (cells[2 * i]! < 0 ? 0 : lut[classValue(cells[2 * i]!, cells[2 * i + 1]!)]!));
        expect(unmasked.filter((v) => v).length).toBeGreaterThan(100);
      }
    });
  }

  it("model seeding gives 0 on imagery nodata and NaN, and seedFromModel elsewhere", { timeout: 30_000 }, async () => {
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [100], std: [50], classes: ["lo", "hi"], W: [[-1], [1]], b: [0, 0] };
    const { source } = imagery();
    const r = ok(await seedModel(source, model, 0, fresh(), "replace"));
    for (const w of tileWindows(1000, 1000)) {
      const want = seedFromModel(model, await source.readWindow(w.x0, w.y0, w.width, w.height), 0, [1, 2]);
      for (let i = 0; i < want.length; i++) if (inNodata(w.x0 + (i % w.width), w.y0 + Math.floor(i / w.width)) || inNan(w.x0 + (i % w.width), w.y0 + Math.floor(i / w.width))) want[i] = 0;
      expect(Buffer.from(at(r.store, w)).equals(Buffer.from(want)), `${w.x0},${w.y0}`).toBe(true);
    }
    expect(at(r.store, { x0: 256, y0: 256, width: 256, height: 256 })[(420 - 256) * 256 + (420 - 256)]).toBe(0);
  });
});

describe("stale runs (spec 003's rule for replaced rasters)", () => {
  it("stops and returns \"stale\" once another raster opened", async () => {
    let calls = 0;
    const file: LabelSource = await open(classFile("255"));
    expect(await importLabels(imagery().source, file, null, fresh(), "replace", () => ++calls > 2)).toBe("stale");
    const { source, reads } = imagery();
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b"], W: [[1], [-1]], b: [0, 0] };
    expect(await seedModel(source, model, 0, fresh(), "replace", () => reads.length >= 2)).toBe("stale");
    expect(reads).toHaveLength(2);
  });
});
