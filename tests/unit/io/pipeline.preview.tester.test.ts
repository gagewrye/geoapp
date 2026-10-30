import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { MAX_READ_BYTES } from "../../../src/core/imagery";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { buildPreview } from "../../../src/io/pipeline";
import type { ImagerySource } from "../../../src/io/source";
import { fakeSource } from "../helpers/sources";
import { uint8Tiff } from "../helpers/tiffFixtures";

// Spec 020 criterion 10, tester: preview reads on odd files.
const GEO = { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] as [number, number, number, number, number, number] };

/** A source of the given block layout that records sample reads and refuses them, so nothing large is allocated. */
function refusing(W: number, H: number, bw: number, bh: number, bandCount = 3) {
  const { source: inner } = fakeSource({ width: W, height: H, bandCount }, () => 1);
  const reads: { w: number; h: number; bands: number[] }[] = [];
  const source: ImagerySource = {
    ...inner, overviews: [], block: { width: bw, height: bh, bytes: bw * bh * bandCount, sampleBytes: 1 },
    readSamples: async (_i, _x, _y, w, h, bands) => { reads.push({ w, h, bands }); throw new Error("stop"); },
  };
  return { source, reads };
}

describe("preview reads, tester", () => {
  it("a 2-band file reads band 0 only, and a 1 x 1 file gives the same preview as through readWindow", async () => {
    const two = refusing(2000, 1500, 256, 256, 2);
    await expect(buildPreview(two.source, 1024)).rejects.toThrow("stop");
    expect(two.reads[0]!.bands).toEqual([0]);
    const src = await openGeoTiff(await fromArrayBuffer(uint8Tiff([{ width: 1, height: 1, bands: 3, value: (k) => 10 * k, layout: { rows: 1 } }], GEO)));
    const p = await buildPreview(src, 1024);
    const before = await buildPreview({ meta: src.meta, readWindow: src.readWindow.bind(src) }, 1024);
    expect(Buffer.from(p.rgba).equals(Buffer.from(before.rgba))).toBe(true);
    expect(p.rgba.some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
  });

  it("a tiled file's edge blocks (partial tiles) are read and give the right edge pixels", async () => {
    const v = (k: number, c: number, r: number) => (c >= 599 || r >= 399 ? 250 : (k * 30 + c + r) % 200);
    const buf = uint8Tiff([{ width: 600, height: 400, bands: 3, value: v, layout: { tile: [256, 256] } }], GEO);
    const src = await openGeoTiff(await fromArrayBuffer(buf));
    const p = await buildPreview(src, 1024);
    const before = await buildPreview({ meta: src.meta, readWindow: src.readWindow.bind(src) }, 1024);
    expect(Buffer.from(p.rgba).equals(Buffer.from(before.rgba))).toBe(true);
  });

  // CLAUDE.md: "Never load a full raster into memory." Before spec 020 a single-strip file was read in 256 px windows.
  // Now its one block is one read, so the read's output arrays alone hold the whole sampled image (here 108 MB),
  // on top of geotiff.js decoding the strip.
  it("a single-strip 6000 x 6000 RGB file's preview reads stay within MAX_READ_BYTES each (was B3)", async () => {
    const { source, reads } = refusing(6000, 6000, 6000, 6000);
    await expect(buildPreview(source, 1024)).rejects.toThrow("stop");
    for (const r of reads) expect(r.w * r.h * r.bands.length).toBeLessThanOrEqual(MAX_READ_BYTES);
  });
});
