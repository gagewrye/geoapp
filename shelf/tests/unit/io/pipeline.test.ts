// Copy of tests/unit/io/pipeline.test.ts before spec 013, for its train, classify and checkClassify tests; the kept file holds the rest.
import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { fit } from "../../../src/core/fit";
import { labelSamples } from "../../../src/core/labelSamples";
import { brush, emptyStore, labelWindows } from "../../../src/core/labelStore";
import { predictTile } from "../../../src/core/predict";
import type { Affine, Model } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { buildPreview, checkClassify, classify, openRaster, RasterRefusedError, train } from "../../../src/io/pipeline";
import { fakeSource, geotiffBuffer, recordingSink } from "../helpers/sources";

/** Paint value over [c0, r0, c1, r1) with all-valid masks (the brush's masks are tested in paintQueue). */
function paint(store: ReturnType<typeof emptyStore>, [c0, r0, c1, r1]: number[], value: number) {
  const w = { x0: c0!, y0: r0!, width: c1! - c0!, height: r1! - r0! };
  const masks = new Map(Array.from({ length: 64 }, (_, i) => [`${(i % 8) * 256},${Math.floor(i / 8) * 256}`, new Uint8Array(8192)]));
  brush(store, masks, w, value, false);
}
const value = (b: number, c: number, r: number) => (b === 0 ? (c < 1024 ? 10 : 50) : b === 1 ? r % 13 : (c + r) % 5);
const model1 = (classes: string[], W: number[][], mean = [30], std = [20]): Model =>
  ({ version: 1, type: "logreg", bands: [1], mean, std, classes, W, b: classes.map(() => 0) });

describe("windowed I/O on a 2048x2048 source (criterion 8)", () => {
  // spec 003 criterion 8 replaces spec 001's bounding-box rule: training reads exactly the stored tiles
  it("trains reading exactly the stored tiles' windows, once each and each at most 256x256; samples = labelled non-nodata pixels", async () => {
    const nd = (c: number, r: number) => c >= 1550 && c < 1560 && r >= 1950 && r < 1960;
    const make = () => fakeSource({ width: 2048, height: 2048, nodata: -1 }, (b, c, r) => (b === 2 && nd(c, r) ? -1 : value(b, c, r)));
    const { source, reads } = make();
    const store = emptyStore(2048, 2048);
    paint(store, [300, 300, 520, 400], 1);
    // all-valid masks label the 10x10 nodata block too, as a hook write could; training skips it
    paint(store, [1500, 1900, 1600, 2000], 2);
    const { model, samples } = (await train(source, store, ["low", "high"], { epochs: 30 })) as { model: Model; samples: number };
    expect(samples).toBe(220 * 100 + 100 * 100 - 100);
    expect(model.classes).toEqual(["low", "high"]);
    expect(model.bands).toEqual([1, 2, 3]);
    expect(reads.map((w) => `${w.x0},${w.y0},${w.width},${w.height}`)).toEqual(labelWindows(store).map((w) => `${w.x0},${w.y0},256,256`));
    expect(reads).toHaveLength(4);
    // and the model is fit on exactly those samples
    const other = make().source;
    const parts = await Promise.all(labelWindows(store).map(async (w) =>
      labelSamples(await other.readWindow(w.x0, w.y0, w.width, w.height), store.tiles.get(`${w.x0},${w.y0}`)!, [1, 2, 3])));
    const X = Float32Array.from(parts.flatMap((p) => [...p.X])), y = Uint8Array.from(parts.flatMap((p) => [...p.y]));
    expect(model).toEqual(fit(X, y, [1, 2, 3], ["low", "high"], { epochs: 30 }));
  });

  it("trains on the labels as they were when called: edits during its reads change neither N nor the model", async () => {
    const make = () => fakeSource({ width: 2048, height: 2048 }, value);
    const store = emptyStore(2048, 2048);
    paint(store, [300, 300, 320, 320], 1);
    paint(store, [1100, 300, 1120, 320], 2);
    paint(store, [1100, 1100, 1110, 1110], 2);
    const want = (await train(make().source, store, ["low", "high"], { epochs: 30 })) as { model: Model; samples: number };
    const { source: inner } = make();
    const reads: string[] = [];
    const source = { meta: inner.meta, async readWindow(x0: number, y0: number, w: number, h: number) {
      reads.push(`${x0},${y0}`);
      if (reads.length === 1) {
        brush(store, new Map(), { x0: 1024, y0: 256, width: 256, height: 256 }, 2, true); // empties a later tile
        paint(store, [1100, 1100, 1110, 1110], 1); // relabels another
        paint(store, [1800, 1800, 1810, 1810], 1); // labels a new tile
      }
      return inner.readWindow(x0, y0, w, h);
    } };
    const got = await train(source, store, ["low", "high"], { epochs: 30 });
    expect(got).toEqual(want);
    expect(reads).toEqual(["256,256", "1024,256", "1024,1024"]);
  });

  it("classifies from windows <= 256x256 with every write after the header <= 65,536 bytes", async () => {
    const { source, reads } = fakeSource({ width: 2048, height: 2048 }, value);
    const rec = recordingSink();
    await classify(source, model1(["low", "high"], [[-1], [1]]), rec.sink);
    expect(reads).toHaveLength(64);
    expect(reads.every((w) => w.width <= 256 && w.height <= 256)).toBe(true);
    expect(rec.writes.length).toBe(65);
    expect(rec.writes.slice(1).every((w) => w.length <= 65536)).toBe(true);
  });

  it("builds the preview tile by tile", async () => {
    const { source, reads } = fakeSource({ width: 2048, height: 2048 }, value);
    const p = await buildPreview(source, 512);
    expect(Math.max(p.width, p.height)).toBe(512);
    expect(reads.every((w) => w.width <= 256 && w.height <= 256)).toBe(true);
    expect(reads).toHaveLength(64);
  });
});

describe("export read back with geotiff.js (criterion 9)", () => {
  it("keeps size, origin, resolution and GeoKeys, with 256x256 tiles, GDAL_NODATA 255 and predictTile pixels", async () => {
    const gt: Affine = [400000, 30, 0, 5300000, 0, -30];
    const buf = geotiffBuffer(300, 260, 2, (b, c, r) => (b === 0 && c === 5 && r === 7 ? -9 : b === 0 ? c : r), { epsg: 32633, gt, nodata: "-9" });
    const input = await (await fromArrayBuffer(buf)).getImage();
    const source = await openGeoTiff(await fromArrayBuffer(buf));
    const model: Model = { version: 1, type: "logreg", bands: [1, 2], mean: [150, 130], std: [80, 70], classes: ["a", "b", "c"], W: [[1, 0], [0, 1], [-1, -1]], b: [0, 0, 0.2] };
    const rec = recordingSink();
    await classify(source, model, rec.sink);
    const out = await (await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer)).getImage();
    expect([out.getWidth(), out.getHeight()]).toEqual([300, 260]);
    expect(out.getOrigin()).toEqual(input.getOrigin());
    expect(out.getResolution()).toEqual(input.getResolution());
    expect(out.getGeoKeys()).toEqual(input.getGeoKeys());
    expect([out.getTileWidth(), out.getTileHeight()]).toEqual([256, 256]);
    expect(out.fileDirectory.getValue("GDAL_NODATA")).toBe("255\u0000");
    const [px] = (await out.readRasters()) as unknown as Uint8Array[];
    const expected = predictTile(model, await source.readWindow(0, 0, 300, 260));
    expect(new Set(expected).size).toBeGreaterThanOrEqual(3);
    expect(Array.from(px!)).toEqual(Array.from(expected));
    expect(px![7 * 300 + 5]).toBe(255);
  });

  it("rejects an oversize raster before reading or writing", async () => {
    const { source, reads } = fakeSource({ width: 70000, height: 70000 }, value);
    const rec = recordingSink();
    await expect(classify(source, model1(["a", "b"], [[1], [-1]]), rec.sink)).rejects.toThrow(/too large/);
    expect(reads).toHaveLength(0);
    expect(rec.writes).toHaveLength(0);
  });

  it("checkClassify rejects an oversize raster or invalid model without a sink or any read (criterion 9)", async () => {
    const big = fakeSource({ width: 70000, height: 70000 }, value);
    expect(() => checkClassify(big.source, model1(["a", "b"], [[1], [-1]]))).toThrow(/too large/);
    const small = fakeSource({ width: 300, height: 200, bandCount: 1 }, value);
    expect(() => checkClassify(small.source, { ...model1(["a", "b"], [[1], [-1]]), bands: [2] })).toThrow(/bands/);
    expect(() => checkClassify(small.source, model1(["a", "b"], [[1], [-1]]))).not.toThrow();
    expect(big.reads).toHaveLength(0);
    expect(small.reads).toHaveLength(0);
  });
});

describe("opening rasters at 180 degrees (criterion 16)", () => {
  const isRefusal = (reason: string) => (e: unknown) => e instanceof RasterRefusedError && e.reason === reason;
  const refuse = async (epsg: number, gt: Affine, w: number, h: number) => {
    const { source, reads } = fakeSource({ width: w, height: h, epsg, gt }, () => 1);
    await expect(openRaster(source)).rejects.toSatisfy(isRefusal("antimeridian"));
    expect(reads).toHaveLength(0);
  };

  it("refuses EPSG:4326 and EPSG:3857 extents crossing 180 without reading a tile", async () => {
    await refuse(4326, [179.5, 0.01, 0, 10, 0, -0.01], 100, 100);
    await refuse(3857, [19900000, 1000, 0, 100000, 0, -1000], 200, 100);
  });

  it("opens an EPSG:4326 raster with an edge exactly at 180 and a UTM zone 60 raster touching 180", async () => {
    const cases: [number, Affine, number][] = [[4326, [179, 0.001, 0, 10, 0, -0.001], 1000], [32660, [800000, 30, 0, 1110000, 0, -30], 1000]];
    for (const [epsg, gt, w] of cases) {
      const { source } = fakeSource({ width: w, height: 100, epsg, gt }, () => 1);
      await expect(openRaster(source)).resolves.toBeUndefined();
      const p = await buildPreview(source, 64);
      expect(p.corners[1]![0]).toBeGreaterThanOrEqual(180 - 1e-9);
      expect(p.corners[1]![0] - p.corners[0]![0]).toBeLessThan(5);
    }
  });

  it("refuses an unsupported CRS", async () => {
    const { source } = fakeSource({ width: 10, height: 10, epsg: 2154 }, () => 1);
    await expect(openRaster(source)).rejects.toSatisfy(isRefusal("crs"));
  });
});
