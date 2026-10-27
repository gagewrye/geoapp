import { describe, expect, it } from "vitest";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import { predictTile } from "../../../src/core/predict";
import { labelSamples } from "../../../src/core/labelSamples";
import type { Model } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";

type Typed = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** 4x1 single-band GeoTIFF of the given sample type, GDAL_NODATA written verbatim (or absent). */
function tiff(values: Typed, nodata?: string): ArrayBuffer {
  // geotiff.js 3.0.5 garbles Int16/Int32 on write, so write the bits unsigned and flip SampleFormat to 2
  if (values instanceof Int16Array || values instanceof Int32Array) {
    const bits = values instanceof Int16Array ? new Uint16Array(values.buffer.slice(0)) : new Uint32Array(values.buffer.slice(0));
    return setSampleFormat(write(bits, nodata), 2);
  }
  return write(values, nodata);
}

function setSampleFormat(buf: ArrayBuffer, format: number): ArrayBuffer {
  const v = new DataView(buf);
  const le = v.getUint16(0) === 0x4949;
  const ifd = v.getUint32(4, le);
  const n = v.getUint16(ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (v.getUint16(e, le) === 339) { v.setUint16(e + 8, format, le); return buf; }
  }
  throw new Error("no SampleFormat tag");
}

function write(values: Typed, nodata?: string): ArrayBuffer {
  return writeArrayBuffer(values, {
    width: values.length, height: 1, SamplesPerPixel: 1, ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 400000, 5300000, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32633, ...(nodata !== undefined ? { GDAL_NODATA: nodata } : {}),
  });
}

// class 1 above the threshold, class 0 below; 255 at nodata
const all = new Uint8Array(4).fill(1); // every pixel labelled
const model = (threshold: number): Model => ({ version: 1, type: "logreg", bands: [1], mean: [threshold], std: [1], classes: ["lo", "hi"], W: [[-1], [1]], b: [0, 0] });

async function run(values: Typed, nodata: string | undefined, threshold: number) {
  const src = await openGeoTiff(await fromArrayBuffer(tiff(values, nodata)));
  const t = await src.readWindow(0, 0, values.length, 1);
  return { src, t, pred: Array.from(predictTile(model(threshold), t)) };
}

describe("GDAL nodata on integer and float rasters (criteria 5, 7, 9)", () => {
  const cases: [string, Typed, string, number][] = [
    ["Uint8 0", Uint8Array.from([1, 9, 0, 9]), "0", 5],
    ["Uint8 255", Uint8Array.from([1, 9, 255, 9]), "255", 5],
    ["Int8 -128", Int8Array.from([-5, 5, -128, 5]), "-128", 0],
    ["Uint16 65535", Uint16Array.from([1, 9, 65535, 9]), "65535", 5],
    ["Int16 -32768", Int16Array.from([-5, 5, -32768, 5]), "-32768", 0],
    ["Uint32 4294967295", Uint32Array.from([1, 9, 4294967295, 9]), "4294967295", 5],
    ["Int32 -2147483647 (not float32-exact)", Int32Array.from([-5, 5, -2147483647, 5]), "-2147483647", 0],
    ["Float32 -3.4028234663852886e+38 (GDAL's FLT_MAX form)", Float32Array.from([-5, 5, -3.4028234663852886e38, 5]), "-3.4028234663852886e+38", 0],
    ["Float32 -9999.0", Float32Array.from([-5, 5, -9999, 5]), "-9999.0", 0],
    ["Float32 1e-3", Float32Array.from([-5, 5, 1e-3, 5]), "0.001", 0],
    ["Float64 0.1", Float64Array.from([-5, 5, 0.1, 5]), "0.1", 0],
    ["Float64 -1.7976931348623157e+308", Float64Array.from([-5, 5, -1.7976931348623157e308, 5]), "-1.7976931348623157e+308", 0],
    ["Float32 nan", Float32Array.from([-5, 5, NaN, 5]), "nan", 0],
  ];
  it.each(cases)("%s: the nodata pixel predicts 255 and is not sampled", async (_name, values, nd, threshold) => {
    const { t, pred } = await run(values, nd, threshold);
    expect(pred).toEqual([0, 1, 255, 1]);
    expect(labelSamples(t, all, [1]).y.length).toBe(3);
  });

  // geotiff.js parses GDAL's "-inf"/"inf" as NaN, which would match no pixel
  it.each([
    ["-inf", -Infinity], ["-Inf", -Infinity], ["inf", Infinity], ["+inf", Infinity], ["INF", Infinity],
  ] as const)("GDAL_NODATA %s: nodata is %d and that pixel predicts 255 and is not sampled", async (nd, value) => {
    const { src, t, pred } = await run(Float32Array.from([-5, 5, value, 5]), nd, 0);
    expect(src.meta.nodata).toBe(value);
    expect(pred).toEqual([0, 1, 255, 1]);
    expect(labelSamples(t, all, [1]).y.length).toBe(3);
  });

  it("valid neighbours of a float nodata stay valid", async () => {
    // 0.1 as float32 and its float32 neighbours: only the exact value is nodata
    const nd = Math.fround(0.1);
    const up = new Float32Array([nd]);
    new Uint32Array(up.buffer)[0]! += 1;
    const { pred } = await run(Float32Array.from([-5, up[0]!, 0.1, 5]), "0.1", 0);
    expect(pred).toEqual([0, 1, 255, 1]);
  });

  it("no GDAL_NODATA: nodata is null and only NaN predicts 255", async () => {
    const { src, t, pred } = await run(Float32Array.from([-5, 5, -9999, NaN]), undefined, 0);
    expect(src.meta.nodata).toBeNull();
    expect(t.nodata).toBeNull();
    expect(pred).toEqual([0, 1, 0, 255]);
  });

  it("an integer raster without nodata never predicts 255", async () => {
    const { src, pred } = await run(Uint8Array.from([0, 255, 0, 255]), undefined, 100);
    expect(src.meta.nodata).toBeNull();
    expect(pred).toEqual([0, 1, 0, 1]);
  });
});
