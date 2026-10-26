import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { applyAffine, toLonLat } from "../../../src/core/crs";
import { predictTile } from "../../../src/core/predict";
import type { Affine, Model } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { buildPreview, checkClassify, classify, openRaster, RasterRefusedError, train } from "../../../src/io/pipeline";
import { fakeSource, geotiffBuffer, recordingSink } from "../helpers/sources";

type Feature = GeoJSON.Feature<GeoJSON.Polygon, { label: number }>;

/** Lon/lat polygon for a pixel rectangle of a source. */
function pixelRect(epsg: number, gt: Affine, [c0, r0, c1, r1]: number[], label: number): Feature {
  const ring = [[c0!, r0!], [c1!, r0!], [c1!, r1!], [c0!, r1!], [c0!, r0!]].map(([c, r]) => toLonLat(epsg, ...applyAffine(gt, c!, r!)));
  return { type: "Feature", properties: { label }, geometry: { type: "Polygon", coordinates: [ring] } };
}
const value = (b: number, c: number, r: number) => (b === 0 ? (c < 1024 ? 10 : 50) : b === 1 ? r % 13 : (c + r) % 5);
const model1 = (classes: string[], W: number[][], mean = [30], std = [20]): Model =>
  ({ version: 1, type: "logreg", bands: [1], mean, std, classes, W, b: classes.map(() => 0) });

describe("windowed I/O on a 2048x2048 source (criterion 8)", () => {
  it("trains from windows <= 256x256 that intersect a polygon bbox only", async () => {
    const { source, reads } = fakeSource({ width: 2048, height: 2048 }, value);
    const { gt, epsg } = source.meta;
    const boxes = [[300, 300, 520, 400], [1500.5, 1900, 1600, 2000]];
    const feats = [pixelRect(epsg, gt, boxes[0]!, 0), pixelRect(epsg, gt, boxes[1]!, 1)];
    const { model, samples } = await train(source, feats, ["low", "high"], { epochs: 30 });
    expect(samples).toBeGreaterThan(30000);
    expect(model.classes).toEqual(["low", "high"]);
    expect(model.bands).toEqual([1, 2, 3]);
    expect(reads.length).toBe(4); // each box spans 2 windows across, 1 down
    for (const w of reads) {
      expect(w.width).toBeLessThanOrEqual(256);
      expect(w.height).toBeLessThanOrEqual(256);
      expect(w.x0 % 256).toBe(0);
      expect(w.y0 % 256).toBe(0);
      const hit = boxes.some(([x0, y0, x1, y1]) => x1! + 0.01 > w.x0 && x0! - 0.01 < w.x0 + w.width && y1! + 0.01 > w.y0 && y0! - 0.01 < w.y0 + w.height);
      expect(hit).toBe(true);
    }
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
