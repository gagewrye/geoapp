import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { maskBit, nodataMask } from "../../../src/core/nodata";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { geotiffBuffer } from "../helpers/sources";
import { uint8Tiff, withOverviews, type FixtureImage } from "../helpers/tiffFixtures";

describe("geotiff.js source", () => {
  it("reads metadata and windows", async () => {
    const buf = geotiffBuffer(300, 200, 2, (b, c, r) => b * 1000 + r * 0.5 + c, { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30], nodata: "-9" });
    const src = await openGeoTiff(await fromArrayBuffer(buf));
    expect(src.meta).toMatchObject({ width: 300, height: 200, bandCount: 2, epsg: 32633, nodata: -9, gt: [400000, 30, 0, 5300000, 0, -30] });
    expect(src.meta.geoTags.ModelTiepoint).toEqual([0, 0, 0, 400000, 5300000, 0]);
    const t = await src.readWindow(256, 128, 44, 72);
    expect(t).toMatchObject({ x0: 256, y0: 128, width: 44, height: 72, nodata: -9 });
    expect(t.bands[1]).toBeInstanceOf(Float32Array);
    expect(t.bands[1]![0]).toBe(1000 + 64 + 256);
    expect(t.bands[0]![71 * 44 + 43]).toBe(199 * 0.5 + 299);
  });

  it("reads EPSG:4326 geographic keys", async () => {
    const buf = geotiffBuffer(10, 10, 1, () => 1, { epsg: 4326, gt: [170, 1, 0, 10, 0, -1] });
    const src = await openGeoTiff(await fromArrayBuffer(buf));
    expect(src.meta.epsg).toBe(4326);
    expect(src.meta.nodata).toBeNull();
  });

  it.each(["-3.4e+38", "0.1"])("matches float nodata %s after float32 rounding (criteria 5, 7, 9)", async (nd) => {
    const buf = geotiffBuffer(4, 1, 1, (_b, c) => (c === 2 ? Number(nd) : c), { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30], nodata: nd });
    const src = await openGeoTiff(await fromArrayBuffer(buf));
    const t = await src.readWindow(0, 0, 4, 1);
    const m = nodataMask(t);
    expect([0, 1, 2, 3].map((i) => maskBit(m, i))).toEqual([0, 0, 1, 0]);
  });
});

describe("blocks, overviews and sample reads (spec 020)", () => {
  const geo = { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] as [number, number, number, number, number, number] };
  const v = (k: number, c: number, r: number) => (k * 50 + c + 3 * r) % 251;

  it("reports a tiled block's size and bytes, and lists overviews with the same bands only", async () => {
    const images: FixtureImage[] = [
      ...withOverviews(600, 400, 3, v, [2, 4], [128, 64]),
      { width: 300, height: 200, bands: 1, value: v, layout: { tile: [128, 128] }, subfile: 1 }, // other bands
      { width: 300, height: 200, bands: 3, value: v, layout: { tile: [128, 128] }, subfile: 5 }, // a mask overview
      { width: 50, height: 40, bands: 3, value: v, layout: { rows: 40 } }, // a second page, not an overview
    ];
    const src = await openGeoTiff(await fromArrayBuffer(uint8Tiff(images, geo)));
    expect(src.block).toEqual({ width: 128, height: 64, bytes: 128 * 64 * 3, sampleBytes: 1 });
    expect(src.overviews).toEqual([{ index: 1, width: 300, height: 200 }, { index: 2, width: 150, height: 100 }]);
  });

  it("reports a strip as width x RowsPerStrip", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(uint8Tiff([{ width: 70, height: 50, bands: 1, value: v, layout: { rows: 8 } }], geo)));
    expect(src.block).toEqual({ width: 70, height: 8, bytes: 560, sampleBytes: 1 });
    expect(src.overviews).toEqual([]);
    const single = await openGeoTiff(await fromArrayBuffer(geotiffBuffer(30, 20, 3, () => 1, geo)));
    expect(single.block).toEqual({ width: 30, height: 20, bytes: 30 * 20 * 3 * 4, sampleBytes: 4 });
  });

  it("reads the asked bands of a window as raw typed arrays, from the full image or an overview", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(uint8Tiff(withOverviews(600, 400, 4, v, [2], [128, 64]), geo)));
    const full = await src.readSamples(0, 100, 50, 40, 30, [0, 1, 2]);
    expect(full).toHaveLength(3);
    expect(full[0]).toBeInstanceOf(Uint8Array);
    expect(full[2]![29 * 40 + 39]).toBe(v(2, 139, 79));
    const ov = await src.readSamples(1, 10, 20, 5, 5, [0]);
    expect(ov).toHaveLength(1);
    expect(ov[0]![6]).toBe(v(0, 22, 42));
  });

  it("rejects an aborted read with AbortError", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(uint8Tiff(withOverviews(600, 400, 3, v, [], [128, 64]), geo)));
    const ac = new AbortController();
    ac.abort();
    await expect(src.readSamples(0, 0, 0, 600, 400, [0, 1, 2], ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
