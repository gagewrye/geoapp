import { fromArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { geotiffBuffer } from "./sources";
import { tiledGeotiffBuffer } from "./tiledTiff";

// Spec 072: the tiled fixtures read back as the strip fixture does, in tiles.
describe("tiledGeotiffBuffer", () => {
  it("reads back with the strip writer's grid and pixels, in 256 px tiles", async () => {
    const f = (b: number, c: number, r: number) => b * 1000 + c + r * 0.5;
    const geo = { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] as const, nodata: "0" };
    const [tiled, strip] = await Promise.all([tiledGeotiffBuffer(300, 270, 3, f, { ...geo, gt: [...geo.gt] }), geotiffBuffer(300, 270, 3, f, { ...geo, gt: [...geo.gt] })]
      .map(async (b) => (await fromArrayBuffer(b)).getImage()));
    expect([tiled!.getTileWidth(), tiled!.getTileHeight(), tiled!.getWidth(), tiled!.getHeight()]).toEqual([256, 256, 300, 270]);
    expect(tiled!.getOrigin()).toEqual(strip!.getOrigin());
    expect(tiled!.getResolution()).toEqual(strip!.getResolution());
    expect(tiled!.getGDALNoData()).toBe(0);
    expect(tiled!.getGeoKeys()).toMatchObject({ GeographicTypeGeoKey: 4326 });
    const [a, b] = await Promise.all([tiled!.readRasters({ interleave: true }), strip!.readRasters({ interleave: true })]);
    expect(Array.from(a as Float32Array)).toEqual(Array.from(b as Float32Array));
  });
});
