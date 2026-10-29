import { fromArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { buildPreview } from "../../../src/io/pipeline";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import type { RasterSource } from "../../../src/io/source";
import { fakeSource, geotiffBuffer } from "../helpers/sources";

// Spec 019 criteria 1-3: progress per window read, unchanged previews, and abort between reads.

/** FNV-1a over the RGBA bytes, with the size and corners, so a changed preview changes the digest. */
function digest(p: { rgba: Uint8ClampedArray; width: number; height: number; corners: number[][] }): string {
  let h = 0x811c9dc5;
  for (const b of p.rgba) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `${p.width}x${p.height} ${h.toString(16)} ${JSON.stringify(p.corners)}`;
}

const value = (b: number, c: number, r: number) => (b === 0 ? (c < 1024 ? 10 : 50) : b === 1 ? r % 13 : (c + r) % 5);
const rgb = (b: number, c: number, r: number) => {
  const lon = 10 + (c + 0.5) * 0.01, lat = 50 - (r + 0.5) * 0.01;
  if (Math.abs(lon - 15.5) < 0.05 && Math.abs(lat - 45.5) < 0.05) return 255;
  return b === 0 ? (c < 500 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150;
};

/** The pipeline tests' fake sources and the e2e RGB fixture read through geotiff.js, with digests from before spec 019. */
const FIXTURES: [string, () => Promise<{ source: RasterSource; maxSide: number }>, string][] = [
  ["fake 2048 UTM", async () => ({ source: fakeSource({ width: 2048, height: 2048 }, value).source, maxSide: 512 }),
    "510x512 d09d57a1 [[14.999999999999998,45.153477183356024],[15.781597177366914,45.153477183356024],[15.781597177366914,44.59776310312053],[14.999999999999998,44.59776310312053]]"],
  ["fake 4326 at 180", async () => ({ source: fakeSource({ width: 1000, height: 100, epsg: 4326, gt: [179, 0.001, 0, 10, 0, -0.001] }, () => 1).source, maxSide: 64 }),
    "64x7 8b6ed3c5 [[178.99999999999997,10.000000000000002],[180.008,10.000000000000002],[180.008,9.887999999999998],[178.99999999999997,9.887999999999998]]"],
  ["fake UTM 60", async () => ({ source: fakeSource({ width: 1000, height: 100, epsg: 32660, gt: [800000, 30, 0, 1110000, 0, -30] }, () => 1).source, maxSide: 64 }),
    "64x8 6b061c75 [[179.73635258655042,10.030199743269202],[180.012205734212,10.030199743269202],[180.012205734212,9.997463710592262],[179.73635258655042,9.997463710592262]]"],
  ["fake nodata grey", async () => ({ source: fakeSource({ width: 700, height: 300, bandCount: 1, nodata: 0 }, (_b, c, r) => (c + r) % 7).source, maxSide: 256 }),
    "256x110 61a27786 [[14.999999999999998,45.153477183356024],[15.267921782937186,45.153477183356024],[15.267921782937186,45.07214807542684],[14.999999999999998,45.07214807542684]]"],
  ["geotiff rgb4326", async () => ({ source: await openGeoTiff(await fromArrayBuffer(geotiffBuffer(1000, 1000, 3, rgb, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }))), maxSide: 1024 }),
    "721x1024 59b25e50 [[10,49.99999999999999],[20,49.99999999999999],[20,40.00000000000001],[10,40.00000000000001]]"],
];

describe("buildPreview progress (criterion 1)", () => {
  it("reports once per window read, done 1..total in order, total = reads", async () => {
    const { source, reads } = fakeSource({ width: 1000, height: 600 }, value);
    const calls: [number, number, number][] = [];
    await buildPreview(source, 256, { onProgress: (done, total) => calls.push([done, total, reads.length]) });
    expect(reads.length).toBeGreaterThan(1);
    expect(calls).toEqual(reads.map((_, i) => [i + 1, reads.length, i + 1]));
  });
});

describe("unchanged previews (criterion 2)", () => {
  it.each(FIXTURES)("%s", async (_name, make, expected) => {
    const { source, maxSide } = await make();
    expect(digest(await buildPreview(source, maxSide))).toBe(expected);
    const again = await make();
    expect(digest(await buildPreview(again.source, again.maxSide, { onProgress: () => {}, signal: new AbortController().signal }))).toBe(expected);
  });
});

describe("abort (criterion 3)", () => {
  it.each([0, 3, 14])("an abort during window %i stops the reads after it and rejects with AbortError", async (k) => {
    const { source, reads } = fakeSource({ width: 1000, height: 1000 }, value);
    const ac = new AbortController();
    const read = source.readWindow.bind(source);
    source.readWindow = async (...a) => {
      const t = await read(...a);
      if (reads.length === k + 1) ac.abort();
      return t;
    };
    await expect(buildPreview(source, 256, { signal: ac.signal })).rejects.toSatisfy((e) => (e as Error).name === "AbortError");
    expect(reads).toHaveLength(k + 1);
  });

  it("an already aborted signal reads nothing", async () => {
    const { source, reads } = fakeSource({ width: 300, height: 300 }, value);
    const ac = new AbortController();
    ac.abort(new Error("other reason"));
    await expect(buildPreview(source, 256, { signal: ac.signal })).rejects.toSatisfy((e) => (e as Error).name === "AbortError");
    expect(reads).toHaveLength(0);
  });
});
