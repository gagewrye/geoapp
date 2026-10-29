import { describe, expect, it } from "vitest";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import { maskBit, nodataMask } from "../../../src/core/nodata";
import type { Tile } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";

// Tester: gdalNoData() in src/io/geotiffSource.ts on GDAL_NODATA spellings other than the
// implementer's "-inf"/"inf"/"+inf"/"INF". Expectations follow C strtod, which GDAL uses.

function tiff(values: Float32Array, nodata?: string): ArrayBuffer {
  return writeArrayBuffer(values, {
    width: values.length, height: 1, SamplesPerPixel: 1, ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 400000, 5300000, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32633, ...(nodata !== undefined ? { GDAL_NODATA: nodata } : {}),
  });
}

/** Each pixel's nodata mask bit: 1 where the brush and seeds never label. */
const maskOf = (t: Tile) => { const m = nodataMask(t); return Array.from({ length: t.width * t.height }, (_, i) => maskBit(m, i)); };

async function open(values: Float32Array, nodata?: string) {
  const src = await openGeoTiff(await fromArrayBuffer(tiff(values, nodata)));
  const t = await src.readWindow(0, 0, values.length, 1);
  return { src, t, mask: maskOf(t) };
}

describe("GDAL_NODATA infinity spellings (tester, issue 3a)", () => {
  it.each([
    ["-infinity", -Infinity], ["-Infinity", -Infinity], ["-INFINITY", -Infinity], [" -inf", -Infinity], ["-inf ", -Infinity],
    ["\t-inf", -Infinity], ["infinity", Infinity], ["Infinity", Infinity], ["+Infinity", Infinity], [" inf", Infinity],
    ["1e999", Infinity], ["-1e999", -Infinity],
  ] as const)("%j is read as %d; only that pixel is masked", async (nd, value) => {
    const { src, t, mask } = await open(Float32Array.from([-5, 5, value, 5]), nd);
    expect(src.meta.nodata).toBe(value);
    expect(t.nodata).toBe(value);
    expect(mask).toEqual([0, 0, 1, 0]);
  });

  it("-inf nodata does not also mark +inf pixels (sign is kept)", async () => {
    const { mask } = await open(Float32Array.from([-5, Infinity, -Infinity, 5]), "-inf");
    expect(mask).toEqual([0, 0, 1, 0]);
  });

  it("inf nodata does not also mark -inf pixels", async () => {
    const { mask } = await open(Float32Array.from([-5, -Infinity, Infinity, 5]), "inf");
    expect(mask).toEqual([0, 0, 1, 0]);
  });

  it.each(["nan", "NaN", "-nan", " nan", "NAN"])("%j stays NaN: only NaN pixels are nodata, infinities are not", async (nd) => {
    const { src, mask } = await open(Float32Array.from([-5, Infinity, NaN, -Infinity]), nd);
    expect(Number.isNaN(src.meta.nodata)).toBe(true);
    expect(mask).toEqual([0, 0, 1, 0]);
  });

  it.each(["-9999", " -9999", "-9999 "])("finite %j is unaffected by the infinity path", async (nd) => {
    const { src, mask } = await open(Float32Array.from([-5, 5, -9999, -Infinity]), nd);
    expect(src.meta.nodata).toBe(-9999);
    expect(mask).toEqual([0, 0, 1, 0]);
  });
});
