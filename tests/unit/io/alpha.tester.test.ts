import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import type { Affine } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { ImageryLoader } from "../../../src/io/imageryLoader";
import { windowLabels } from "../../../src/io/maskBase";
import { buildPreview } from "../../../src/io/pipeline";
import { importLabels } from "../../../src/io/seeding";
import type { ImagerySource } from "../../../src/io/source";
import { fakeLabelSource } from "../helpers/labelFiles";
import { uint8Tiff, type FixtureImage } from "../helpers/tiffFixtures";

// Spec 022, tester: alpha after an unspecified extra sample, alpha in an overview, and a fully transparent raster.
const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
const GEO = { epsg: 32633, gt };

/** Logs every readSamples call's image and bands. */
function logged(src: ImagerySource) {
  const reads: { image: number; bands: number[] }[] = [];
  const read = src.readSamples.bind(src);
  src.readSamples = (image, x0, y0, w, h, bands, signal) => { reads.push({ image, bands: [...bands] }); return read(image, x0, y0, w, h, bands, signal); };
  return reads;
}

describe("RGB + an unspecified extra sample + alpha (ExtraSamples [0, 2])", () => {
  // band 3 (NIR-like, ExtraSamples 0) is 0 where alpha is 255, so it must not count as alpha or nodata
  const v = (k: number, c: number, r: number) => (k === 4 ? (c < 20 ? 0 : 255) : k === 3 ? (c % 2 ? 0 : 9) : c < 20 ? 0 : 100 + ((c + r + k) % 101));
  const buf = () => uint8Tiff([{ width: 300, height: 200, bands: 5, value: v, layout: { tile: [64, 64] }, extraSamples: [0, 2] }], GEO);

  it("has alpha 4; the preview reads [0, 1, 2, 4], is transparent west of c = 20 and stretches over visible pixels only", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(buf()));
    expect(src.meta.alpha).toBe(4);
    const reads = logged(src);
    const p = await buildPreview(src, 1024);
    expect(new Set(reads.map((r) => r.bands.join()))).toEqual(new Set(["0,1,2,4"]));
    expect(p.ranges).toEqual([[100, 200], [100, 200], [100, 200]]);
    const alphas = new Set<number>();
    for (let i = 3; i < p.rgba.length; i += 4) alphas.add(p.rgba[i]!);
    expect(alphas).toEqual(new Set([0, 255]));
  });

  it("a mask reads only sample 4, and band 3's zeros take no label away", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(buf()));
    const reads = logged(src);
    const file = fakeLabelSource({ width: 300, height: 200, gt, epsg: 32633 }, () => 1).source;
    const lut = new Uint8Array(256); lut[1] = 1;
    const r = (await windowLabels(src, file, lut, { x0: 0, y0: 0, width: 256, height: 200 }))!;
    expect(reads.map((x) => x.bands)).toEqual([[4]]);
    for (let c = 0; c < 256; c++) expect(r.labels[100 * 256 + c], `c ${c}`).toBe(c < 20 ? 0 : 1);
  });
});

describe("an overview with alpha", () => {
  const v = (k: number, c: number) => (k === 3 ? (c < 600 ? 0 : 255) : c < 600 ? 0 : 150);
  const images: FixtureImage[] = [
    { width: 2400, height: 1200, bands: 4, value: v, layout: { tile: [256, 256] }, extraSamples: [2] },
    { width: 1200, height: 600, bands: 4, value: (k, c) => v(k, 2 * c), layout: { tile: [256, 256] }, extraSamples: [2], subfile: 1 },
  ];

  it("is the preview's source with alpha honoured, and tiles drawn from it are transparent where its alpha is 0", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(uint8Tiff(images, GEO)));
    expect(src.overviews.map((o) => o.index)).toEqual([1]);
    const reads = logged(src);
    const p = await buildPreview(src, 1024);
    expect(new Set(reads.map((r) => `${r.image}:${r.bands.join()}`))).toEqual(new Set(["1:0,1,2,3"]));
    const drawn = new Map<string, Uint8ClampedArray>();
    const loader = new ImageryLoader(src, p.ranges, { use: (k) => drawn.has(k), draw: (k, _l, _t, rgba) => { drawn.set(k, rgba.slice()); } });
    const grid = { width: 1200, height: 600, epsg: 32633, gt: [500000, 20, 0, 5000000, 0, -20] as Affine };
    loader.show({ level: { s: 2, overview: 1, grid }, tiles: [{ x0: 256, y0: 0, width: 256, height: 256 }] });
    await expect.poll(() => drawn.size).toBe(1);
    const t = drawn.get("2-256,0")!;
    // overview column 256 + i: transparent while 2 * (256 + i) < 600, i.e. i < 44
    for (const i of [0, 43, 44, 255]) expect(t[4 * (10 * 256 + i) + 3], `i ${i}`).toBe(i < 44 ? 0 : 255);
    expect(reads.filter((r) => r.image === 1).at(-1)!.bands).toEqual([0, 1, 2, 3]);
  });
});

describe("a fully transparent raster", () => {
  const buf = () => uint8Tiff([{ width: 600, height: 300, bands: 4, value: () => 0, layout: { rows: 1 }, extraSamples: [2] }], GEO);

  it("builds an all-transparent preview without error, and an import over it is empty", async () => {
    const src = await openGeoTiff(await fromArrayBuffer(buf()));
    const p = await buildPreview(src, 1024);
    for (let i = 3; i < p.rgba.length; i += 4) expect(p.rgba[i]).toBe(0);
    const file = fakeLabelSource({ width: 600, height: 300, gt, epsg: 32633 }, () => 1).source;
    expect(await importLabels(src, file, [{ value: 1, name: "one" }])).toBe("empty");
  });
});
