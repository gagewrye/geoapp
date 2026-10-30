import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { blobSource, MAX_FETCH, MERGE_GAP } from "../../../src/io/blobSource";
import { openFile, openGeoTiff } from "../../../src/io/geotiffSource";
import { LabelFileRefused, maskReadFailed, openLabelFile, openLabelTiff } from "../../../src/io/labelFile";
import { buildPreview } from "../../../src/io/pipeline";
import { classFile, CLASS_GRID, rgbClassFile } from "../helpers/labelFiles";
import { geotiffBuffer } from "../helpers/sources";
import { uint8Tiff } from "../helpers/tiffFixtures";

// Spec 025, tester edge cases: label offsets, in-flight aborts, failed runs, empty inputs, run size bounds, NaN.
const GEO = { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] as [number, number, number, number, number, number] };
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + (i >> 9)) & 255);
const eq = (a: ArrayBuffer, b: ArrayBuffer) => Buffer.from(a).equals(Buffer.from(b));
const u8eq = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const u = a as Uint8Array, v = b as Uint8Array;
  return u.constructor === v.constructor && Buffer.from(u.buffer, u.byteOffset, u.byteLength).equals(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
};

/** A Blob whose slice() calls are logged, and whose arrayBuffer() can be made to fail. */
function counted(data: Uint8Array<ArrayBuffer> | ArrayBuffer, failWhen?: (start: number, end: number) => boolean) {
  const blob = new Blob([data]);
  const slices: [number, number][] = [];
  const slice = blob.slice.bind(blob);
  blob.slice = (start = 0, end = blob.size, type?: string) => {
    slices.push([start, end]);
    const part = slice(start, end, type);
    if (failWhen?.(start, end)) part.arrayBuffer = () => Promise.reject(new DOMException("gone", "NotReadableError"));
    return part;
  };
  return { blob, slices };
}

/** A one-band Uint8 label file in 1-row strips: its offset arrays are deferred by geotiff. */
const stripLabel = (value: (c: number, r: number) => number) =>
  uint8Tiff([{ width: 260, height: 900, bands: 1, value: (_k, c, r) => value(c, r), layout: { rows: 1 } }], GEO);

describe("label file through blobSource", () => {
  it("reads no strip offsets or counts after open (criterion 3, label file)", async () => {
    const buf = stripLabel((c, r) => (c * 3 + r) % 7);
    const ifd = new DataView(buf).getUint32(4, true);
    const { blob, slices } = counted(buf);
    const src = await openLabelFile(blob);
    slices.length = 0;
    for (const w of [{ x0: 0, y0: 0, width: 260, height: 1 }, { x0: 250, y0: 890, width: 10, height: 10 }, { x0: 30, y0: 400, width: 100, height: 77 }]) await src.read(w);
    expect(slices.length).toBeGreaterThan(0);
    for (const [, end] of slices) expect(end).toBeLessThanOrEqual(ifd);
  });

  it("decodes byte-equal at the raster's edges and for a single-class file (criterion 4)", async () => {
    for (const buf of [stripLabel((c, r) => (c ^ r) & 255), stripLabel(() => 7), classFile(null, CLASS_GRID, () => 3)]) {
      const a = await openLabelFile(new Blob([buf]));
      const b = await openLabelTiff(await fromArrayBuffer(buf));
      expect(a.meta).toEqual(b.meta);
      const { width: W, height: H } = a.meta;
      for (const w of [{ x0: W - 1, y0: H - 1, width: 1, height: 1 }, { x0: 0, y0: H - 3, width: W, height: 3 }, { x0: W - 5, y0: 0, width: 5, height: H }]) {
        expect(u8eq(await a.read(w), await b.read(w))).toBe(true);
      }
    }
  });

  it("still refuses a 3-band file", async () => {
    await expect(openLabelFile(new Blob([rgbClassFile()]))).rejects.toBeInstanceOf(LabelFileRefused);
  });

  it("a read that fails with NotReadableError still counts as the mask file gone", async () => {
    const buf = stripLabel((c, r) => (c + r) % 5);
    const ifd = new DataView(buf).getUint32(4, true);
    let failing = false;
    const { blob } = counted(buf, (_s, end) => failing && end <= ifd);
    const src = await openLabelFile(blob);
    failing = true;
    const e = await src.read({ x0: 0, y0: 0, width: 50, height: 50 }).catch((x: unknown) => x);
    expect(maskReadFailed(e)).toBe(true);
  });
});

describe("blobSource edge cases (criterion 2)", () => {
  it("an abort after the run's read started rejects only its own fetch", async () => {
    const data = bytes(20_000);
    const { blob, slices } = counted(data);
    // hold every run's read until released, so the abort lands while it is in flight
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slice = blob.slice.bind(blob);
    blob.slice = (s?: number, e?: number) => { const part = slice(s, e); const ab = part.arrayBuffer.bind(part); part.arrayBuffer = () => gate.then(ab); return part; };
    const src = blobSource(blob);
    const ac = new AbortController();
    const a = src.fetch([{ offset: 0, length: 500 }, { offset: 9000, length: 500 }], ac.signal);
    const b = src.fetch([{ offset: 500, length: 500 }]);
    await new Promise((r) => setTimeout(r, 5)); // flushed: the run's slice is made
    expect(slices).toHaveLength(1);
    ac.abort();
    release();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(eq((await b)[0]!, data.slice(500, 1000).buffer)).toBe(true);
  });

  it("a failed run rejects its callers only; fetches in other runs still get their bytes", async () => {
    const data = bytes(MERGE_GAP * 4);
    const { blob } = counted(data, (start) => start === 0);
    const src = blobSource(blob);
    const bad = src.fetch([{ offset: 0, length: 100 }]);
    const alsoBad = src.fetch([{ offset: 100, length: 100 }, { offset: MERGE_GAP * 3, length: 100 }]);
    const good = src.fetch([{ offset: MERGE_GAP * 3 + 100, length: 100 }]);
    await expect(bad).rejects.toMatchObject({ name: "NotReadableError" });
    await expect(alsoBad).rejects.toMatchObject({ name: "NotReadableError" });
    expect(eq((await good)[0]!, data.slice(MERGE_GAP * 3 + 100, MERGE_GAP * 3 + 200).buffer)).toBe(true);
  });

  it("handles no slices, zero-length slices and an empty file without reading", async () => {
    const { blob, slices } = counted(bytes(1000));
    const src = blobSource(blob);
    expect(await src.fetch([])).toEqual([]);
    const [z] = await src.fetch([{ offset: 10, length: 0 }]);
    expect(z!.byteLength).toBe(0);
    expect(slices).toHaveLength(0);
    const empty = blobSource(new Blob([]));
    expect(empty.fileSize).toBe(0);
    const [h] = await empty.fetch([{ offset: 0, length: 1024 }]);
    expect(h!.byteLength).toBe(0);
  });

  it("gives the same bytes for duplicate and nested slices in one batch", async () => {
    const data = bytes(5000);
    const src = blobSource(new Blob([data]));
    const req = [{ offset: 100, length: 400 }, { offset: 100, length: 400 }, { offset: 200, length: 10 }, { offset: 0, length: 5000 }];
    const got = (await Promise.all([src.fetch(req), src.fetch(req.slice(0, 1))])).flat();
    [...req, req[0]!].forEach(({ offset, length }, i) => expect(eq(got[i]!, data.slice(offset, offset + length).buffer)).toBe(true));
  });

  it("fetches made in a later task are a separate read", async () => {
    const { blob, slices } = counted(bytes(4000));
    const src = blobSource(blob);
    await src.fetch([{ offset: 0, length: 100 }]);
    await src.fetch([{ offset: 100, length: 100 }]);
    expect(slices).toEqual([[0, 100], [100, 200]]);
  });
});

describe("run size bounds (memory, structural)", () => {
  it("no read is longer than MAX_FETCH unless one slice is, over 40 MiB of adjacent 1 MiB blocks", async () => {
    const MiB = 2 ** 20;
    const { blob, slices } = counted(new Uint8Array(41 * MiB));
    const src = blobSource(blob);
    await Promise.all(Array.from({ length: 40 }, (_, i) => src.fetch([{ offset: i * MiB, length: MiB }])));
    expect(slices.every(([s, e]) => e - s <= MAX_FETCH)).toBe(true);
    expect(slices.reduce((n, [s, e]) => n + e - s, 0)).toBe(40 * MiB);
    expect(slices).toHaveLength(3);
    slices.length = 0;
    await Promise.all([src.fetch([{ offset: 0, length: 10 }]), src.fetch([{ offset: 10, length: MAX_FETCH + 5 }]), src.fetch([{ offset: MAX_FETCH + 15, length: 10 }])]);
    expect(slices).toEqual([[0, 10], [10, MAX_FETCH + 15], [MAX_FETCH + 15, MAX_FETCH + 25]]);
  });

  it("every read made while opening and reading a strip file stays within the file", async () => {
    const buf = uint8Tiff([{ width: 300, height: 700, bands: 3, value: (k, c, r) => (k + c * r) & 255, layout: { rows: 1 } }], GEO);
    const { blob, slices } = counted(buf);
    const src = await openFile(blob);
    await src.readSamples(0, 0, 0, 300, 700, [0, 1, 2]);
    expect(slices.every(([s, e]) => s >= 0 && e <= buf.byteLength && e > s)).toBe(true);
  });
});

describe("imagery through blobSource", () => {
  it("decodes Float32 NaN and nodata pixels byte-equal (criterion 4)", async () => {
    const buf = geotiffBuffer(120, 90, 2, (b, c, r) => ((c + r) % 9 === 0 ? NaN : (c * r) % 11 === 0 ? -9 : b + c * 0.25 - r), { ...GEO, nodata: "-9" });
    const a = await openFile(new Blob([buf]));
    const b = await openGeoTiff(await fromArrayBuffer(buf));
    expect(a.meta).toEqual(b.meta);
    const [ta, tb] = await Promise.all([a.readWindow(113, 80, 7, 10), b.readWindow(113, 80, 7, 10)]);
    expect(ta.bands.every((x, i) => u8eq(x, tb.bands[i]!))).toBe(true);
  });

  it("builds the same preview as fromArrayBuffer for 1-row strips, with reads in parallel", async () => {
    const buf = uint8Tiff([{ width: 900, height: 1300, bands: 3, value: (k, c, r) => (k * 70 + c * 5 + r * 3) & 255, layout: { rows: 1 } }], GEO);
    const progress: number[] = [];
    const a = await buildPreview(await openFile(new Blob([buf])), 256, { onProgress: (d) => progress.push(d) });
    const b = await buildPreview(await openGeoTiff(await fromArrayBuffer(buf)), 256);
    expect(a).toEqual(b);
    expect(progress).toEqual(progress.map((_, i) => i + 1));
  });
});
