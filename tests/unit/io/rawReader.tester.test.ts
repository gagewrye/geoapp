import { describe, expect, it } from "vitest";
import { fromArrayBuffer, type GeoTIFFImage } from "geotiff";
import { openFile } from "../../../src/io/geotiffSource";
import { rawEligible, rawOffsets, rawWindow } from "../../../src/io/rawReader";
import { rawTiff, type RawImage } from "../helpers/rawTiffs";

// Spec 028 criteria 1 and 2, tester edge cases: through blobSource (as the app reads), more sample types, odd
// blockings, repeated samples, windows past the edge, empty windows, sparse blocks, and bytes fetched (memory).
const ints = (k: number, c: number, r: number) => (k * 977 + c * 31 + r * 17) % 65536;
const view = (a: ArrayLike<number>) => { const t = a as Uint8Array; return Buffer.from(t.buffer, t.byteOffset, t.byteLength); };
const same = (got: ArrayLike<number>[], want: ArrayLike<number>[]) => {
  expect(got).toHaveLength(want.length);
  got.forEach((g, i) => {
    expect(g.constructor).toBe(want[i]!.constructor);
    expect(view(g).equals(view(want[i]!)), `array ${i}`).toBe(true);
  });
};
const geotiffRead = async (image: GeoTIFFImage, x0: number, y0: number, w: number, h: number, samples: number[]) =>
  Array.from((await image.readRasters({ window: [x0, y0, x0 + w, y0 + h], samples: [...samples] })) as unknown as ArrayLike<number>[]);

/** A Blob whose slice() calls are logged. */
function counted(buf: ArrayBuffer) {
  const blob = new Blob([buf]);
  const slices: [number, number][] = [];
  const slice = blob.slice.bind(blob);
  blob.slice = (s = 0, e = blob.size, t?: string) => { slices.push([s, e]); return slice(s, e, t); };
  return { blob, slices };
}

const WINDOWS: [number, number, number, number][] = [[0, 0, 1, 1], [13, 7, 61, 45], [290, 3, 10, 200], [0, 190, 300, 10], [299, 199, 1, 1], [0, 0, 300, 200], [100, 50, 128, 128]];

describe("raw reads through blobSource, as the app reads (criterion 1)", () => {
  const cases: [string, RawImage][] = [
    ["uint16 256² tiles", { width: 300, height: 200, layout: { tile: [256, 256] }, bits: 16, format: 1, value: ints, bands: 3 }],
    ["float32 1-row strips", { width: 300, height: 200, layout: { rows: 1 }, bits: 32, format: 3, value: (k, c, r) => Math.fround(ints(k, c, r) / 3 - 7.5), bands: 2 }],
    ["int16 16-row strips", { width: 300, height: 200, layout: { rows: 16 }, bits: 16, format: 2, value: (k, c, r) => ints(k, c, r) - 32768, bands: 2 }],
    ["uint8 RGBA 64² tiles", { width: 300, height: 200, layout: { tile: [64, 64] }, bits: 8, value: (k, c, r) => ints(k, c, r) & 255, bands: 4 }],
  ];
  it.each(cases)("%s: every window, read together in one batch, is byte-equal to geotiff", async (_n, im) => {
    const buf = rawTiff([im]);
    const src = await openFile(new Blob([buf]));
    expect(src.raw).toEqual([0]);
    const image = await (await fromArrayBuffer(buf)).getImage(0);
    const samples = [...Array(im.bands).keys()].reverse();
    const got = await Promise.all(WINDOWS.map(([x0, y0, w, h]) => src.readSamples!(0, x0, y0, w, h, samples)));
    for (const [i, [x0, y0, w, h]] of WINDOWS.entries()) same(got[i]!, await geotiffRead(image, x0, y0, w, h, samples));
  });
});

describe("raw reads, more types and layouts (criterion 1)", () => {
  const check = async (im: RawImage, samplesOf: (bands: number) => number[] = (b) => [...Array(b).keys()]) => {
    const tiff = await fromArrayBuffer(rawTiff([im]));
    const image = await tiff.getImage(0);
    expect(rawEligible(image)).toBe(true);
    const offsets = await rawOffsets(image);
    for (const [x0, y0, w, h] of WINDOWS) {
      const samples = samplesOf(im.bands);
      same(await rawWindow(image, tiff.source, offsets, x0, y0, w, h, samples), await geotiffRead(image, x0, y0, w, h, samples));
    }
  };
  const base = { width: 300, height: 200, layout: { rows: 16 } as RawImage["layout"], bands: 3 };
  it.each([
    ["int8", { ...base, bits: 8, format: 2 as const, value: (k: number, c: number, r: number) => (ints(k, c, r) & 255) - 128 }],
    ["uint32", { ...base, bits: 32, format: 1 as const, value: (k: number, c: number, r: number) => ints(k, c, r) * 65521 }],
    ["int32", { ...base, bits: 32, format: 2 as const, value: (k: number, c: number, r: number) => ints(k, c, r) * 30011 - 2 ** 30 }],
    ["float64", { ...base, bits: 64, format: 3 as const, value: (k: number, c: number, r: number) => ints(k, c, r) / 9 - 1e6 }],
  ])("%s", async (_n, im) => { await check(im); });

  it.each([["one strip", { rows: 200 }], ["7-row strips (last strip short)", { rows: 7 }], ["RowsPerStrip over the height", { rows: 5000 }],
    ["32x16 tiles", { tile: [32, 16] }]] as [string, RawImage["layout"]][])("uint8, %s", async (_n, layout) => {
    await check({ ...base, layout, bits: 8, value: (k, c, r) => ints(k, c, r) & 255 });
  });

  it("repeated and reordered samples", async () => {
    await check({ ...base, bits: 16, value: ints }, () => [2, 0, 2, 1]);
  });

  it("a single-band image", async () => {
    await check({ ...base, bands: 1, bits: 8, value: (_k, c, r) => (c * r) & 255 });
  });
});

describe("raw window bounds (criterion 1)", () => {
  it("a window running past the right and bottom edges equals geotiff (outside stays 0)", async () => {
    const tiff = await fromArrayBuffer(rawTiff([{ width: 300, height: 200, layout: { tile: [256, 256] }, bits: 16, value: (k, c, r) => 1 + ints(k, c, r) % 60000, bands: 2 }]));
    const image = await tiff.getImage(0);
    const offsets = await rawOffsets(image);
    for (const [x0, y0, w, h] of [[280, 190, 40, 30], [0, 195, 300, 20], [295, 0, 20, 200]] as const) {
      same(await rawWindow(image, tiff.source, offsets, x0, y0, w, h, [0, 1]), await geotiffRead(image, x0, y0, w, h, [0, 1]));
    }
  });

  it("an empty window or no samples reads nothing", async () => {
    const tiff = await fromArrayBuffer(rawTiff([{ width: 300, height: 200, layout: { rows: 1 }, bits: 8, value: () => 5, bands: 3 }]));
    const image = await tiff.getImage(0);
    const offsets = await rawOffsets(image);
    let fetched = 0;
    const source = { fetch: (s: { offset: number; length: number }[], sig?: AbortSignal) => { fetched += s.length; return tiff.source.fetch(s, sig); } };
    const [a] = await rawWindow(image, source, offsets, 10, 10, 0, 5, [0]);
    expect(a!.length).toBe(0);
    expect(await rawWindow(image, source, offsets, 10, 10, 5, 5, [])).toEqual([]);
    expect(fetched).toBe(0);
  });

  it("an out-of-range sample index throws, as geotiff does", async () => {
    const tiff = await fromArrayBuffer(rawTiff([{ width: 30, height: 20, layout: { rows: 1 }, bits: 8, value: () => 5, bands: 3 }]));
    const image = await tiff.getImage(0);
    await expect(rawWindow(image, tiff.source, await rawOffsets(image), 0, 0, 5, 5, [3])).rejects.toThrow();
    await expect(geotiffRead(image, 0, 0, 5, 5, [3])).rejects.toThrow();
  });
});

describe("sparse blocks (criterion 1)", () => {
  /** Sets the byte count of strip or tile k to 0, as GDAL writes a block of nodata in a sparse file. */
  function sparse(buf: ArrayBuffer, tag: number, k: number): ArrayBuffer {
    const v = new DataView(buf), ifd = v.getUint32(4, true), n = v.getUint16(ifd, true);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (v.getUint16(e, true) !== tag) continue;
      const count = v.getUint32(e + 4, true), at = count > 1 ? v.getUint32(e + 8, true) : e + 8;
      v.setUint32(at + 4 * k, 0, true);
    }
    return buf;
  }
  it.each([["strips", { rows: 16 }, 279, 3], ["tiles", { tile: [64, 64] }, 325, 6]] as [string, RawImage["layout"], number, number][])(
    "a %s block stored with no bytes reads as geotiff fills it", async (_n, layout, tag, k) => {
      const tiff = await fromArrayBuffer(sparse(rawTiff([{ width: 300, height: 200, layout, bits: 16, value: (b, c, r) => 1 + ints(b, c, r) % 60000, bands: 2 }]), tag, k));
      const image = await tiff.getImage(0);
      const offsets = await rawOffsets(image);
      expect(offsets.counts[k]).toBe(0);
      for (const [x0, y0, w, h] of WINDOWS) same(await rawWindow(image, tiff.source, offsets, x0, y0, w, h, [1, 0]), await geotiffRead(image, x0, y0, w, h, [1, 0]));
    });
});

describe("bytes fetched (memory, structural)", () => {
  it("a 256² window of wide 1-row strips fetches only the window's columns: 256 KiB, not whole rows", async () => {
    // rows 68,000 B apart, beyond MERGE_GAP, as on Chunk 11 (147,664 B)
    const W = 17000, H = 300;
    const buf = rawTiff([{ width: W, height: H, layout: { rows: 1 }, bits: 8, value: (k, c, r) => (k + c + r) & 255, bands: 4 }]);
    const { blob, slices } = counted(buf);
    const src = await openFile(blob);
    slices.length = 0;
    const got = await src.readSamples!(0, 8000, 20, 256, 256, [0, 1, 2, 3]);
    expect(got[0]![0]).toBe((0 + 8000 + 20) & 255);
    const total = slices.reduce((n, [s, e]) => n + e - s, 0);
    expect(total).toBe(256 * 256 * 4);
    expect(slices.every(([s, e]) => e - s === 1024)).toBe(true);
  });
});
