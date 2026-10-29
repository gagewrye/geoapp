// Copy of tests/unit/io/geotiffSource.test.ts before spec 013, for its predictTile and labelSamples assertions; the kept file checks the same nodata through nodataMask.
import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { predictTile } from "../../../src/core/predict";
import type { Model } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { geotiffBuffer } from "../helpers/sources";

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
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b"], W: [[-1], [1]], b: [0, 0] };
    expect(Array.from(predictTile(model, t))).toEqual([0, 1, 255, 1]);
  });
});
