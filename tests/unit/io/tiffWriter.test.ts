import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { MAX_TIFF_BYTES, tiffLayout, writeTiff } from "../../../src/io/tiffWriter";
import { recordingSink } from "../helpers/sources";

const geo = { GeoKeyDirectory: [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 32633], ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 500000, 5000000, 0], GeoAsciiParams: "WGS 84 / UTM 33N|" };

describe("tiled TIFF writer (ADR 0001)", () => {
  it("writes a classic tiled Uint8 GeoTIFF that geotiff.js reads back", async () => {
    const rec = recordingSink();
    const w = 300, h = 270;
    await writeTiff(rec.sink, w, h, geo, async (win) => {
      const t = new Uint8Array(win.width * win.height);
      for (let r = 0; r < win.height; r++) for (let c = 0; c < win.width; c++) t[r * win.width + c] = (win.x0 + c + 2 * (win.y0 + r)) % 7;
      return t;
    });
    expect(rec.closed).toBe(true);
    expect(rec.writes.slice(1).every((x) => x.length === 65536)).toBe(true);
    expect(rec.writes).toHaveLength(1 + 4);
    const im = await (await fromArrayBuffer(rec.bytes().buffer as ArrayBuffer)).getImage();
    expect([im.getWidth(), im.getHeight(), im.getTileWidth(), im.getTileHeight()]).toEqual([300, 270, 256, 256]);
    expect(im.fileDirectory.getValue("GDAL_NODATA")).toBe("255\u0000");
    expect(im.getGDALNoData()).toBe(255);
    expect(im.getOrigin()).toEqual([500000, 5000000, 0]);
    expect(im.getResolution()).toEqual([30, -30, 0]);
    expect(im.getGeoKeys()).toMatchObject({ ProjectedCSTypeGeoKey: 32633, GTModelTypeGeoKey: 1 });
    expect(im.fileDirectory.getValue("GeoAsciiParams")).toBe("WGS 84 / UTM 33N|\u0000");
    const [px] = (await im.readRasters({ window: [250, 250, 300, 270] })) as unknown as Uint8Array[];
    expect(px![0]).toBe((250 + 500) % 7);
    expect(px![49 + 19 * 50]).toBe((299 + 2 * 269) % 7);
  });

  it("rejects output beyond the classic TIFF limit before writing", async () => {
    expect(() => tiffLayout(70000, 70000, geo)).toThrow(/too large/);
    const rec = recordingSink();
    let reads = 0;
    await expect(writeTiff(rec.sink, 70000, 70000, geo, async () => { reads++; return new Uint8Array(0); })).rejects.toThrow(/too large/);
    expect(rec.writes).toHaveLength(0);
    expect(reads).toBe(0);
    expect(tiffLayout(60000, 60000, geo).totalBytes).toBeLessThanOrEqual(MAX_TIFF_BYTES);
  });
});
