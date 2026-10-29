import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { CLASS_ITEM, decodeClasses } from "../../../src/core/classTable";
import { initialClasses, paletteColour, type LabelClass } from "../../../src/core/classes";
import { emptyStore } from "../../../src/core/labelStore";
import type { Affine } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { checkLabelExport, exportLabels } from "../../../src/io/labelExport";
import { openLabelTiff } from "../../../src/io/labelFile";
import { importLabels, importTable } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { effectiveTiles } from "../helpers/effective";
import { fakeSource, geotiffBuffer, recordingSink } from "../helpers/sources";

// Spec 004 criteria 9 (the written item) and 10 (export).

const GT: Affine = [10, 0.01, 0, 50, 0, -0.01]; // spec 001's EPSG:4326 fixture (rgbFixture)
const fixture = () => geotiffBuffer(1000, 1000, 3, (b, c, r) => (b === 0 ? c % 200 : b === 1 ? r % 100 : 150), { epsg: 4326, gt: GT });

/** The fixture as a source that counts window reads. */
async function counted(): Promise<{ source: RasterSource; reads: number[] }> {
  const inner = await openGeoTiff(await fromArrayBuffer(fixture()));
  const reads: number[] = [];
  return { reads, source: { meta: inner.meta, readWindow: (x0, y0, w, h) => { reads.push(x0); return inner.readWindow(x0, y0, w, h); } } };
}

async function written(source: RasterSource, store: ReturnType<typeof emptyStore>, classes: LabelClass[]) {
  const rec = recordingSink();
  await exportLabels(source, store, classes, rec.sink);
  expect(rec.closed).toBe(true);
  expect(rec.writes.slice(1).every((w) => w.length === 65536)).toBe(true);
  return rec.bytes().buffer as ArrayBuffer;
}

describe("Export labels (criteria 9 and 10)", () => {
  it("keeps the imagery's grid and GeoKeys, with 256x256 tiles, GDAL_NODATA 0, the store's pixels and 0 elsewhere; reads no imagery", { timeout: 30_000 }, async () => {
    const { source, reads } = await counted();
    const store = emptyStore(1000, 1000);
    const a = new Uint8Array(65536); a[0] = 1; a[65535] = 2; a[300] = 3;
    const edge = new Uint8Array(232 * 232); edge[232 * 231 + 231] = 2; edge[5] = 1;
    store.tiles.set("256,0", a);
    store.tiles.set("768,768", edge);
    const classes = [...initialClasses(), { name: "unused", colour: "#abcdef" }];
    const buf = await written(source, store, classes);
    const out = await (await fromArrayBuffer(buf)).getImage();
    const input = await (await fromArrayBuffer(fixture())).getImage();
    expect([out.getWidth(), out.getHeight()]).toEqual([1000, 1000]);
    expect(out.getOrigin()).toEqual(input.getOrigin());
    expect(out.getResolution()).toEqual(input.getResolution());
    expect(out.getGeoKeys()).toEqual(input.getGeoKeys());
    expect([out.getTileWidth(), out.getTileHeight(), out.getSamplesPerPixel()]).toEqual([256, 256, 1]);
    expect(out.fileDirectory.getValue("GDAL_NODATA")).toBe("0\u0000");
    expect(out.getGDALNoData()).toBe(0);
    const [px] = (await out.readRasters()) as unknown as Uint8Array[];
    expect(px).toBeInstanceOf(Uint8Array);
    const want = new Uint8Array(1000 * 1000);
    want[256] = 1; want[255 * 1000 + 511] = 2; want[1 * 1000 + 256 + 44] = 3;
    want[(768 + 231) * 1000 + 768 + 231] = 2; want[768 * 1000 + 773] = 1;
    expect(Buffer.from(px!).equals(Buffer.from(want))).toBe(true);
    // criterion 9: exactly one dataset item, the class table, listing every class
    const md = await out.getGDALMetadata();
    expect(Object.keys(md!)).toEqual([CLASS_ITEM]);
    expect(decodeClasses(md![CLASS_ITEM] as string)).toEqual(classes.map((c, i) => ({ value: i + 1, ...c })));
    expect(reads).toEqual([]);
  });

  it("round-trips class names with XML specials and non-ASCII text through geotiff.js (criterion 9)", async () => {
    const { source } = fakeSource({ width: 20, height: 10, epsg: 4326, gt: GT, geoTags: { GeoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 4326], ModelPixelScale: [0.01, 0.01, 0], ModelTiepoint: [0, 0, 0, 10, 50, 0] } }, () => 1);
    const classes = [{ name: `<a href="x">&amp;</a> 'q'`, colour: "#010203" }, { name: "Forêt 森林 🌳", colour: "#040506" }];
    const out = await (await fromArrayBuffer(await written(source, emptyStore(20, 10), classes))).getImage();
    const md = await out.getGDALMetadata();
    expect(Object.keys(md!)).toEqual([CLASS_ITEM]);
    expect(decodeClasses(md![CLASS_ITEM] as string)).toEqual(classes.map((c, i) => ({ value: i + 1, ...c })));
  });

  it("with 255 classes a class-255 pixel reads back as 255 and imports as class 255", { timeout: 30_000 }, async () => {
    const { source } = await counted();
    const classes = Array.from({ length: 255 }, (_, i) => ({ name: `c${i + 1}`, colour: paletteColour(i) }));
    const store = emptyStore(1000, 1000);
    const t = new Uint8Array(65536); t[10] = 255; t[11] = 1;
    store.tiles.set("0,0", t);
    const buf = await written(source, store, classes);
    const [px] = (await (await (await fromArrayBuffer(buf)).getImage()).readRasters({ window: [0, 0, 20, 1] })) as unknown as Uint8Array[];
    expect([px![10], px![11], px![12]]).toEqual([255, 1, 0]);
    const file = await openLabelTiff(await fromArrayBuffer(buf));
    expect(file.meta.nodata).toBe(0);
    const r = await importLabels(source, file, importTable(file));
    if (typeof r === "string") throw new Error(r);
    expect(r.classes).toEqual(classes);
    const back = await effectiveTiles(source, r); // spec 014: the file is the base
    expect([...back].filter(([, v]) => v.some((x) => x)).map(([k]) => k)).toEqual(["0,0"]);
    expect(Buffer.from(back.get("0,0")!).equals(Buffer.from(t))).toBe(true);
  });

  it("checkLabelExport rejects output beyond the classic TIFF limit before anything is written", () => {
    const { source, reads } = fakeSource({ width: 70000, height: 70000 }, () => 1);
    expect(() => checkLabelExport(source, initialClasses())).toThrow(/too large/);
    expect(reads).toHaveLength(0);
  });
});
