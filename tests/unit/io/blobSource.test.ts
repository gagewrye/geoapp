import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { blobSource, MAX_FETCH, MERGE_GAP } from "../../../src/io/blobSource";
import { openFile, openGeoTiff } from "../../../src/io/geotiffSource";
import { openLabelFile, openLabelTiff } from "../../../src/io/labelFile";
import { classFile } from "../helpers/labelFiles";
import { geotiffBuffer } from "../helpers/sources";
import { uint8Tiff, withOverviews } from "../helpers/tiffFixtures";

// Spec 025 criteria 2-4.
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 255);

/** A Blob whose slice() calls are logged as [start, end]. */
function counted(data: Uint8Array<ArrayBuffer> | ArrayBuffer) {
  const blob = new Blob([data]);
  const slices: [number, number][] = [];
  const slice = blob.slice.bind(blob);
  blob.slice = (start?: number, end?: number, type?: string) => { slices.push([start ?? 0, end ?? blob.size]); return slice(start, end, type); };
  return { blob, slices };
}

const eq = (a: ArrayBuffer, b: ArrayBuffer) => Buffer.from(a).equals(Buffer.from(b));
/** Typed arrays of the same type and bytes; toEqual walks megapixel arrays an element at a time. */
const same = (a: ArrayLike<number>[], b: ArrayLike<number>[]) => a.length === b.length && a.every((x, i) => {
  const u = x as Uint8Array, v = b[i] as Uint8Array;
  return u.constructor === v.constructor && Buffer.from(u.buffer, u.byteOffset, u.byteLength).equals(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
});

describe("blobSource (criterion 2)", () => {
  it("gives the same bytes as blob.slice for random slices", async () => {
    const data = bytes(300_000);
    const { blob } = counted(data);
    const src = blobSource(blob);
    expect(src.fileSize).toBe(300_000);
    let s = 7;
    const rnd = (n: number) => Math.floor(((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
    const slices = Array.from({ length: 200 }, () => ({ offset: rnd(299_000), length: 1 + rnd(rnd(10) ? 2000 : 150_000) }));
    const got = await Promise.all([src.fetch(slices.slice(0, 100)), src.fetch(slices.slice(100))]);
    got.flat().forEach((buf, i) => {
      const { offset, length } = slices[i]!;
      expect(eq(buf, data.slice(offset, Math.min(offset + length, data.length)).buffer)).toBe(true);
    });
  });

  it("reads 256 adjacent strips fetched in one task with 1 slice call", async () => {
    const data = bytes(256 * 1000 + 50);
    const { blob, slices } = counted(data);
    const src = blobSource(blob);
    const got = await Promise.all(Array.from({ length: 256 }, (_, i) => src.fetch([{ offset: 50 + i * 1000, length: 1000 }])));
    expect(slices).toEqual([[50, 256_050]]);
    expect(got.every(([b], i) => b!.byteLength === 1000 && eq(b!, data.slice(50 + i * 1000, 1050 + i * 1000).buffer))).toBe(true);
  });

  it("splits at gaps over MERGE_GAP and runs over MAX_FETCH", async () => {
    const { blob, slices } = counted(bytes(MAX_FETCH + 400_000));
    const src = blobSource(blob);
    await Promise.all([
      src.fetch([{ offset: 0, length: 10 }]), src.fetch([{ offset: 10 + MERGE_GAP, length: 10 }]), src.fetch([{ offset: 30 + 2 * MERGE_GAP + 1, length: 10 }]),
      src.fetch([{ offset: 300_000, length: MAX_FETCH }]), src.fetch([{ offset: 300_000 + MAX_FETCH, length: 10 }]),
    ]);
    expect(slices).toEqual([[0, 20 + MERGE_GAP], [30 + 2 * MERGE_GAP + 1, 40 + 2 * MERGE_GAP + 1], [300_000, 300_000 + MAX_FETCH], [300_000 + MAX_FETCH, 300_010 + MAX_FETCH]]);
  });

  it("clamps the end of the file, as the 1,024-byte header fetch needs", async () => {
    const data = bytes(600);
    const src = blobSource(new Blob([data]));
    const [head, tail, past] = await src.fetch([{ offset: 0, length: 1024 }, { offset: 590, length: 100 }, { offset: 700, length: 10 }]);
    expect(eq(head!, data.buffer)).toBe(true);
    expect(eq(tail!, data.slice(590).buffer)).toBe(true);
    expect(past!.byteLength).toBe(0);
  });

  it("rejects an aborted fetch with AbortError and leaves the others in its run intact", async () => {
    const data = bytes(10_000);
    const { blob, slices } = counted(data);
    const src = blobSource(blob);
    const ac = new AbortController();
    const a = src.fetch([{ offset: 0, length: 100 }], ac.signal);
    const b = src.fetch([{ offset: 100, length: 100 }]);
    ac.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(eq((await b)[0]!, data.slice(100, 200).buffer)).toBe(true);
    const pre = new AbortController();
    pre.abort();
    await expect(src.fetch([{ offset: 0, length: 10 }], pre.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(slices).toHaveLength(1);
  });
});

describe("block offsets at open (criterion 3)", () => {
  it("reads no StripOffsets or StripByteCounts after open, whatever window is read", async () => {
    // 1000 one-row strips: the offset arrays don't fit the IFD's first 1,024 bytes, so geotiff defers them
    const buf = uint8Tiff([{ width: 300, height: 1000, bands: 3, value: (k, c, r) => (k + c + r) & 255, layout: { rows: 1 } }],
      { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] });
    const ifd = new DataView(buf).getUint32(4, true); // pixels come first, then the IFD and its arrays
    const { blob, slices } = counted(buf);
    const src = await openFile(blob);
    slices.length = 0;
    for (const [x0, y0, w, h] of [[0, 0, 300, 1], [10, 500, 50, 40], [290, 990, 10, 10]]) await src.readSamples(0, x0!, y0!, w!, h!, [0, 1, 2]);
    await src.readWindow(5, 700, 20, 30);
    expect(slices.length).toBeGreaterThan(0);
    for (const [, end] of slices) expect(end).toBeLessThanOrEqual(ifd);
  });

  it("loads the block offsets of tiled images and overviews too", async () => {
    const buf = uint8Tiff(withOverviews(4100, 3000, 1, (k, c, r) => (c ^ r) & 255, [2, 4], [64, 64]), { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] });
    const { blob, slices } = counted(buf);
    const src = await openFile(blob);
    const ifd = new DataView(buf).getUint32(4, true);
    slices.length = 0;
    await src.readSamples(0, 1000, 1000, 300, 300, [0]);
    for (const o of src.overviews) await src.readSamples(o.index, 10, 10, 200, 200, [0]);
    for (const [, end] of slices) expect(end).toBeLessThanOrEqual(ifd);
  });
});

describe("decoding through blobSource (criterion 4)", () => {
  const GEO = { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] as [number, number, number, number, number, number] };
  const v = (k: number, c: number, r: number) => (k * 40 + c * 3 + r * 7) % 256;
  const imagery: [string, ArrayBuffer][] = [
    ["tiled", uint8Tiff([{ width: 700, height: 500, bands: 3, value: v, layout: { tile: [256, 256] } }], GEO)],
    ["1-row strips", uint8Tiff([{ width: 300, height: 400, bands: 4, value: v, layout: { rows: 1 } }], GEO)],
    ["overviews", uint8Tiff(withOverviews(1200, 900, 3, v, [2, 4]), GEO)],
    ["single strip, Float32", geotiffBuffer(300, 200, 2, (b, c, r) => b * 1000 + r * 0.5 + c, { ...GEO, nodata: "-9" })],
  ];

  it.each(imagery)("imagery, %s: every window and overview is byte-equal to reading the whole buffer", async (_n, buf) => {
    const a = await openFile(new Blob([buf]));
    const b = await openGeoTiff(await fromArrayBuffer(buf));
    expect(a.meta).toEqual(b.meta);
    expect(a.overviews).toEqual(b.overviews);
    const { width, height } = a.meta;
    for (const [x0, y0, w, h] of [[0, 0, width, height], [7, 3, 50, 61], [width - 9, height - 4, 9, 4]]) {
      const [{ bands: ta, ...ra }, { bands: tb, ...rb }] = await Promise.all([a.readWindow(x0!, y0!, w!, h!), b.readWindow(x0!, y0!, w!, h!)]);
      expect(ra).toEqual(rb);
      expect(same(ta, tb)).toBe(true);
      const [sa, sb] = await Promise.all([a.readSamples(0, x0!, y0!, w!, h!, [0]), b.readSamples(0, x0!, y0!, w!, h!, [0])]);
      expect(same(sa, sb)).toBe(true);
    }
    for (const o of a.overviews) expect(same(await a.readSamples(o.index, 0, 0, o.width, o.height, [0, 1, 2]), await b.readSamples(o.index, 0, 0, o.width, o.height, [0, 1, 2]))).toBe(true);
  });

  it("label files: every window is byte-equal", async () => {
    const buf = classFile();
    const a = await openLabelFile(new Blob([buf]));
    const b = await openLabelTiff(await fromArrayBuffer(buf));
    expect(a.meta).toEqual(b.meta);
    for (const w of [{ x0: 0, y0: 0, width: 240, height: 200 }, { x0: 17, y0: 30, width: 100, height: 100 }]) expect(same([await a.read(w)], [await b.read(w)])).toBe(true);
  });
});
