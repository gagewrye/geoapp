import { describe, expect, it } from "vitest";
import type { Affine } from "../../../src/core/types";
import { buildPreview, openRaster, RasterRefusedError } from "../../../src/io/pipeline";
import { fakeSource } from "../helpers/sources";

const value = (b: number, c: number, r: number) => (b === 0 ? (c < 1024 ? 10 : 50) : b === 1 ? r % 13 : (c + r) % 5);

describe("windowed I/O on a 2048x2048 source (criterion 8)", () => {
  it("builds the preview tile by tile", async () => {
    const { source, reads } = fakeSource({ width: 2048, height: 2048 }, value);
    const p = await buildPreview(source, 512);
    expect(Math.max(p.width, p.height)).toBe(512);
    expect(reads.every((w) => w.width <= 256 && w.height <= 256)).toBe(true);
    expect(reads).toHaveLength(64);
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
