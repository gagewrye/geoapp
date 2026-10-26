import { readFileSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dequantize } from "../../../src/core/aef";
import { openGeoTiff } from "../../../src/io/geotiffSource";

const COGS = "tests/fixtures/aef/cogs/2021/17N";
const buffer = (path: string) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

afterEach(() => vi.unstubAllGlobals());

describe("local AlphaEarth COG (criterion 15)", () => {
  it.each(["west-bottomup", "ne-topdown", "se-bottomup"])("%s: no requests, tiles equal dequantize of its pixels", async (name) => {
    const fetch = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetch);
    const buf = buffer(`${COGS}/fixture-${name}.tiff`);
    const src = await openGeoTiff(await fromArrayBuffer(buf));
    const { width, height, bandCount, nodata } = src.meta;
    expect([bandCount, nodata]).toEqual([64, null]);
    const tile = await src.readWindow(0, 0, width, height);
    const raw = (await (await fromArrayBuffer(buf)).getImage()).readRasters() as unknown as Promise<Int8Array[]>;
    let invalid = 0;
    (await raw).forEach((q, k) => {
      expect(q).toBeInstanceOf(Int8Array);
      const want = new Float32Array(q.length);
      dequantize(q, want);
      expect(tile.bands[k]).toEqual(want); // NaN equals NaN here
      invalid += q.filter((v) => v === -128).length;
    });
    expect(tile.bands[0]!.filter(Number.isNaN).length * 64).toBe(invalid);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the fixture COGs together contain invalid pixels", async () => {
    let n = 0;
    for (const name of ["west-bottomup", "ne-topdown", "se-bottomup"]) {
      const src = await openGeoTiff(await fromArrayBuffer(buffer(`${COGS}/fixture-${name}.tiff`)));
      n += (await src.readWindow(0, 0, src.meta.width, src.meta.height)).bands[5]!.filter(Number.isNaN).length;
    }
    expect(n).toBeGreaterThan(0);
  });

  it("dequantizes the real Source Cooperative header too (64 bands, Int8, nodata -128)", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(buffer("tests/fixtures/aef/real/xm0lu3s74sdjecpf8-0000000000-0000008192.head.tiff")));
    expect(src.meta.nodata).toBeNull();
  });

  it("leaves other Int8 rasters alone", async () => {
    const { writeArrayBuffer } = await import("geotiff");
    const buf = writeArrayBuffer(new Int8Array([-128, 1, 2, 3]), {
      width: 4, height: 1, SamplesPerPixel: 1, BitsPerSample: [8], SampleFormat: [2], GDAL_NODATA: "-128",
      ModelPixelScale: [10, 10, 0], ModelTiepoint: [0, 0, 0, 500000, 2700000, 0], GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32617,
    });
    const src = await openGeoTiff(await fromArrayBuffer(buf));
    expect(src.meta.nodata).toBe(-128);
    expect(Array.from((await src.readWindow(0, 0, 4, 1)).bands[0]!)).toEqual([-128, 1, 2, 3]);
  });
});
