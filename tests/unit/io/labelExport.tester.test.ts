import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { paletteColour, type LabelClass } from "../../../src/core/classes";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore, type LabelStore } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import type { Affine, Model } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { classify } from "../../../src/io/pipeline";
import { exportLabels } from "../../../src/io/labelExport";
import { openLabelTiff } from "../../../src/io/labelFile";
import { importLabels, importTable, seedModel, type SeedOutcome } from "../../../src/io/seeding";
import type { RasterSource } from "../../../src/io/source";
import { geotiffBuffer, recordingSink } from "../helpers/sources";

// Tester round trips of Export labels then Import labels (Replace), spec 004 criteria 9-11 in io:
// several imagery CRSs and odd sizes, hostile and non-ASCII names, the 255th class in an edge
// tile, tile padding, and, structurally, a 20000 x 20000 export written one 64 KiB tile at a time.

const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };

/** Imagery with band 2 nodata (-9999) on a block; labels are placed off it, as every path does. */
async function imagery(width: number, height: number, epsg: number, gt: Affine): Promise<RasterSource> {
  const nd = (c: number, r: number) => c >= 100 && c < 140 && r >= 50 && r < 90;
  return openGeoTiff(await fromArrayBuffer(geotiffBuffer(width, height, 2, (b, c, r) => (b === 1 && nd(c, r) ? -9999 : c + r), { epsg, gt, nodata: "-9999" })));
}

/** A pseudo-random store off imagery nodata, using values 1..n, in a few tiles including the last (edge) one. */
async function storeFor(src: RasterSource, n: number): Promise<LabelStore> {
  const { width, height } = src.meta;
  const store = emptyStore(width, height);
  const ws = tileWindows(width, height);
  let s = 12345;
  for (const w of [ws[0]!, ws[Math.floor(ws.length / 2)]!, ws[ws.length - 1]!]) {
    const mask = nodataMask(await src.readWindow(w.x0, w.y0, w.width, w.height));
    const t = new Uint8Array(w.width * w.height);
    for (let i = 0; i < t.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      if ((mask[i >> 3]! >> (i & 7)) & 1) continue;
      if (s % 3) t[i] = 1 + (s >>> 8) % n;
    }
    t[t.length - 1] = (mask[(t.length - 1) >> 3]! >> ((t.length - 1) & 7)) & 1 ? 0 : n; // the last class in the corner pixel
    store.tiles.set(`${w.x0},${w.y0}`, t);
  }
  return store;
}

async function roundTrip(src: RasterSource, store: LabelStore, classes: LabelClass[]) {
  const rec = recordingSink();
  await exportLabels(src, store, classes, rec.sink);
  const file = await openLabelTiff(await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer));
  const r = ok(await importLabels(src, file, importTable(file), { store: emptyStore(src.meta.width, src.meta.height), classes: [{ name: "scratch", colour: "#000000" }] }, "replace"));
  return { r, rec, file };
}

function expectSame(a: LabelStore, b: LabelStore) {
  expect([...a.tiles.keys()].sort()).toEqual([...b.tiles.keys()].sort());
  for (const [k, t] of a.tiles) expect(Buffer.from(b.tiles.get(k)!).equals(Buffer.from(t)), k).toBe(true);
}

const NAMES = ["Mangrove & <salt>", "\"q\" 'a'", "</Item>", "Wald üß", "水 water", "wave \u{1F30A}", "&amp;lt;"];

describe("export then import restores labels and classes exactly", () => {
  const grids: [string, number, number, number, Affine][] = [
    ["EPSG:4326 777 x 513", 777, 513, 4326, [10, 0.01, 0, 50, 0, -0.01]],
    ["UTM 33N 300 x 700", 300, 700, 32633, [500000, 30, 0, 5000000, 0, -30]],
    ["UTM 33S 513 x 257", 513, 257, 32733, [300000, 10, 0, 7000000, 0, -10]],
    ["EPSG:3857 260 x 260", 260, 260, 3857, [1669792, 40, 0, 5621521, 0, -40]],
  ];
  for (const [name, w, h, epsg, gt] of grids) {
    it(`on ${name}, with hostile and non-ASCII names and an unused class`, { timeout: 30_000 }, async () => {
      const src = await imagery(w, h, epsg, gt);
      const classes = [...NAMES, "unused"].map((n, i) => ({ name: n, colour: paletteColour(i + 3) }));
      const store = await storeFor(src, NAMES.length);
      const { r, file } = await roundTrip(src, store, classes);
      expect(file.meta.nodata).toBe(0);
      expect([file.meta.width, file.meta.height, file.meta.epsg]).toEqual([w, h, epsg]);
      expect(file.meta.gt).toEqual(src.meta.gt);
      expectSame(store, r.store);
      expect(r.classes).toEqual(classes);
    });
  }

  it("with 255 classes, label 255 in the last edge tile reads back as 255 and stays class 255", { timeout: 30_000 }, async () => {
    const src = await imagery(777, 513, 4326, [10, 0.01, 0, 50, 0, -0.01]);
    const classes = Array.from({ length: 255 }, (_, i) => ({ name: `k${i + 1}`, colour: paletteColour(i) }));
    const store = await storeFor(src, 255);
    const last = tileWindows(777, 513).at(-1)!;
    expect(store.tiles.get(`${last.x0},${last.y0}`)!.at(-1)).toBe(255);
    const { r } = await roundTrip(src, store, classes);
    expectSame(store, r.store);
    expect(r.classes).toEqual(classes);
  });

  it("an export with no labels imports as \"empty\" and changes nothing (N = 0)", { timeout: 30_000 }, async () => {
    const src = await imagery(300, 260, 32633, [500000, 30, 0, 5000000, 0, -30]);
    const rec = recordingSink();
    await exportLabels(src, emptyStore(300, 260), [{ name: "only", colour: "#000000" }], rec.sink);
    const file = await openLabelTiff(await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer));
    const current = { store: emptyStore(300, 260), classes: [{ name: "keep", colour: "#111111" }] };
    expect(await importLabels(src, file, importTable(file), current, "replace")).toBe("empty");
    expect(current.classes).toEqual([{ name: "keep", colour: "#111111" }]);
  });

  it("pads edge tiles with 0 (GDAL_NODATA \"0\"), not 255", { timeout: 30_000 }, async () => {
    const src = await imagery(300, 260, 32633, [500000, 30, 0, 5000000, 0, -30]);
    const store = emptyStore(300, 260);
    store.tiles.set("256,256", new Uint8Array(44 * 4).fill(1));
    const rec = recordingSink();
    await exportLabels(src, store, [{ name: "a", colour: "#000000" }], rec.sink);
    const tiles = rec.writes.slice(1);
    expect(tiles).toHaveLength(4);
    const t = tiles[3]!;
    for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) expect(t[r * 256 + c], `${c},${r}`).toBe(c < 44 && r < 4 ? 1 : 0);
  });
});

describe("spec 001's classification export is unchanged", () => {
  it("writes GDAL_NODATA 255, pads with 255 and has no GDAL_METADATA", { timeout: 30_000 }, async () => {
    const src = await imagery(300, 260, 32633, [500000, 30, 0, 5000000, 0, -30]);
    const model: Model = { version: 1, type: "logreg", bands: [2], mean: [250], std: [100], classes: ["a", "b"], W: [[-1], [1]], b: [0, 0] };
    const rec = recordingSink();
    await classify(src, model, rec.sink);
    const image = await (await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer)).getImage();
    expect(image.getGDALNoData()).toBe(255);
    expect(image.fileDirectory.hasTag("GDAL_METADATA")).toBe(false);
    expect(rec.writes.at(-1)![255 * 256 + 255]).toBe(255);
    const [px] = (await image.readRasters({ window: [100, 50, 101, 51] })) as unknown as Uint8Array[];
    expect(px![0]).toBe(255); // band 2 (the model's band) is nodata there
  });
});

describe("export memory, structurally", () => {
  it("a 20000 x 20000 export writes the header, then 6241 tiles of exactly 65536 bytes, and reads no imagery", { timeout: 60_000 }, async () => {
    const meta = (await imagery(10, 10, 32633, [500000, 1, 0, 5000000, 0, -1])).meta;
    const src: RasterSource = { meta: { ...meta, width: 20000, height: 20000 }, readWindow: () => { throw new Error("export read imagery"); } };
    const store = emptyStore(20000, 20000);
    store.tiles.set("19968,19968", new Uint8Array(32 * 32).fill(1));
    let writes = 0, maxBytes = 0, header = 0;
    await exportLabels(src, store, [{ name: "a", colour: "#000000" }], {
      async write(d) { if (writes++ === 0) header = d.length; else maxBytes = Math.max(maxBytes, d.length); },
      async close() {},
    });
    expect(writes).toBe(1 + 79 * 79);
    expect(maxBytes).toBe(65536);
    expect(header).toBeLessThan(200_000);
  });
});

describe("model class names that spec 003's rule refuses", () => {
  // Tester FOLLOW-UP F2: spec 001's model validation doesn't apply spec 003's name rule, so a seed
  // would put names in the list that spec 003 refuses, and its export wouldn't import back the same
  // (" padded " comes back trimmed; an empty name is refused). Seed from model refuses such a model.
  const src = () => imagery(300, 260, 32633, [500000, 30, 0, 5000000, 0, -30]);
  const model = (classes: string[]): Model => ({ version: 1, type: "logreg", bands: [1], mean: [250], std: [100], classes, W: classes.map((_, i) => [i]), b: classes.map(() => 0) });
  for (const [why, classes] of [["an untrimmed", [" padded ", "b"]], ["an empty", ["", "b"]], ["a blank", ["a", "  "]], ["a duplicate", ["a", "b", "a"]]] as const) {
    it(`refuses a model with ${why} class name in either mode, changing nothing`, { timeout: 30_000 }, async () => {
      const s = await src();
      const current = { store: await storeFor(s, 2), classes: [{ name: "x", colour: "#000000" }, { name: "y", colour: "#111111" }] };
      const tiles = new Map(current.store.tiles), list = current.classes.map((c) => ({ ...c }));
      let reads = 0;
      const counted: RasterSource = { meta: s.meta, readWindow: (...a) => { reads++; return s.readWindow(...a); } };
      for (const mode of ["merge", "replace"] as const) expect(await seedModel(counted, model([...classes]), 0, current, mode)).toBe("bad names");
      expect(reads).toBe(0);
      expect(current.store.tiles).toEqual(tiles);
      expect(current.classes).toEqual(list);
    });
  }

  it("a seed from a model with valid names exports and imports back the same list", { timeout: 30_000 }, async () => {
    const s = await src();
    const seeded = ok(await seedModel(s, model(["padded", "b"]), 0, { store: emptyStore(300, 260), classes: [] }, "replace"));
    expect(seeded.classes.map((c) => c.name)).toEqual(["padded", "b"]);
    const { r } = await roundTrip(s, seeded.store, seeded.classes);
    expect(r.classes).toEqual(seeded.classes);
  });
});
