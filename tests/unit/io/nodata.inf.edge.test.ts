import { describe, expect, it } from "vitest";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import { predictTile } from "../../../src/core/predict";
import { samplePixels } from "../../../src/core/sample";
import type { Model } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";

// Tester: gdalNoData() in src/io/geotiffSource.ts on GDAL_NODATA spellings other than the
// implementer's "-inf"/"inf"/"+inf"/"INF". Expectations follow C strtod, which GDAL uses.

function tiff(values: Float32Array, nodata?: string): ArrayBuffer {
  return writeArrayBuffer(values, {
    width: values.length, height: 1, SamplesPerPixel: 1, ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 400000, 5300000, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32633, ...(nodata !== undefined ? { GDAL_NODATA: nodata } : {}),
  });
}

const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["lo", "hi"], W: [[-1], [1]], b: [0, 0] };
const all = { rings: [[[0, 0], [4, 0], [4, 1], [0, 1]] as [number, number][]], label: 0 };

async function open(values: Float32Array, nodata?: string) {
  const src = await openGeoTiff(await fromArrayBuffer(tiff(values, nodata)));
  const t = await src.readWindow(0, 0, values.length, 1);
  return { src, t, pred: Array.from(predictTile(model, t)) };
}

describe("GDAL_NODATA infinity spellings (tester, issue 3a)", () => {
  it.each([
    ["-infinity", -Infinity], ["-Infinity", -Infinity], ["-INFINITY", -Infinity], [" -inf", -Infinity], ["-inf ", -Infinity],
    ["\t-inf", -Infinity], ["infinity", Infinity], ["Infinity", Infinity], ["+Infinity", Infinity], [" inf", Infinity],
    ["1e999", Infinity], ["-1e999", -Infinity],
  ] as const)("%j is read as %d; that pixel predicts 255 and is not sampled", async (nd, value) => {
    const { src, t, pred } = await open(Float32Array.from([-5, 5, value, 5]), nd);
    expect(src.meta.nodata).toBe(value);
    expect(t.nodata).toBe(value);
    expect(pred).toEqual([0, 1, 255, 1]);
    expect(samplePixels(t, [all], [1]).y.length).toBe(3);
  });

  it("-inf nodata does not also mark +inf pixels (sign is kept)", async () => {
    const { pred } = await open(Float32Array.from([-5, Infinity, -Infinity, 5]), "-inf");
    expect(pred[2]).toBe(255);
    expect(pred[1]).not.toBe(255);
  });

  it("inf nodata does not also mark -inf pixels", async () => {
    const { pred } = await open(Float32Array.from([-5, -Infinity, Infinity, 5]), "inf");
    expect(pred[2]).toBe(255);
    expect(pred[1]).not.toBe(255);
  });

  it.each(["nan", "NaN", "-nan", " nan", "NAN"])("%j stays NaN: only NaN pixels are nodata, infinities are not", async (nd) => {
    const { src, pred } = await open(Float32Array.from([-5, Infinity, NaN, -Infinity]), nd);
    expect(Number.isNaN(src.meta.nodata)).toBe(true);
    expect(pred[2]).toBe(255);
    expect(pred[1]).not.toBe(255);
    expect(pred[3]).not.toBe(255);
  });

  it.each(["-9999", " -9999", "-9999 "])("finite %j is unaffected by the infinity path", async (nd) => {
    const { src, pred } = await open(Float32Array.from([-5, 5, -9999, -Infinity]), nd);
    expect(src.meta.nodata).toBe(-9999);
    expect(pred).toEqual([0, 1, 255, 0]);
  });
});
