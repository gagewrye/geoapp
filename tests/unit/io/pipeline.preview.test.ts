import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { tileWindows } from "../../../src/core/grid";
import { MAX_BLOCK_BYTES } from "../../../src/core/imagery";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { buildPreview } from "../../../src/io/pipeline";
import type { ImagerySource, RasterSource } from "../../../src/io/source";
import { geotiffBuffer } from "../helpers/sources";
import { uint8Tiff, withOverviews } from "../helpers/tiffFixtures";

// Spec 020 criterion 10: the preview reads the smallest overview of at least 1024 px, else only the blocks holding a sampled pixel.
const GEO = { epsg: 32633, gt: [400000, 30, 0, 5300000, 0, -30] as [number, number, number, number, number, number] };
const v = (k: number, c: number, r: number) => (k * 40 + c * 3 + r * 7) % 256;

type Read = { image: number; x0: number; y0: number; w: number; h: number; bands: number[] };

/** The GeoTIFF source with its sample reads logged; readWindow must not be called. */
async function logged(buf: ArrayBuffer) {
  const src = await openGeoTiff(await fromArrayBuffer(buf));
  const reads: Read[] = [];
  const source: ImagerySource = {
    ...src,
    readWindow: () => { throw new Error("readWindow"); },
    readSamples: (image, x0, y0, w, h, bands, signal) => { reads.push({ image, x0, y0, w, h, bands }); return src.readSamples(image, x0, y0, w, h, bands, signal); },
  };
  return { source, reads, src };
}

/** The same file read only through readWindow, as before spec 020. */
const windowsOnly = (s: RasterSource): RasterSource => ({ meta: s.meta, readWindow: s.readWindow.bind(s) });

describe("preview reads (criterion 10)", () => {
  it("reads only the smallest overview whose longest side is at least 1024", async () => {
    const { source, reads } = await logged(uint8Tiff(withOverviews(4100, 3000, 3, v, [2, 4, 8], [256, 256]), GEO));
    expect(source.overviews.map((o) => o.width)).toEqual([2050, 1025, 513]);
    const p = await buildPreview(source, 1024);
    expect(new Set(reads.map((r) => r.image))).toEqual(new Set([2]));
    expect(Math.max(p.width, p.height)).toBe(1024);
  });

  it("without one, reads each block at most once, and at most 3 bands", async () => {
    for (const [layout, bands] of [[{ tile: [256, 256] as [number, number] }, 4], [{ rows: 16 }, 3], [{ rows: 1 }, 1]] as const) {
      const { source, reads } = await logged(uint8Tiff([{ width: 2500, height: 1300, bands, value: v, layout }], GEO));
      await buildPreview(source, 1024);
      const bw = source.block.width, bh = source.block.height;
      const keys = reads.map((r) => `${Math.floor(r.x0 / bw)},${Math.floor(r.y0 / bh)}`);
      expect(new Set(keys).size).toBe(reads.length);
      for (const r of reads) {
        expect(Math.floor((r.x0 + r.w - 1) / bw)).toBe(Math.floor(r.x0 / bw));
        expect(Math.floor((r.y0 + r.h - 1) / bh)).toBe(Math.floor(r.y0 / bh));
        expect(r.bands.length).toBeLessThanOrEqual(3);
      }
      if ("rows" in layout && layout.rows === 1) expect(reads.length).toBe(Math.ceil(1300 / 3)); // f = 3: one strip in three
    }
  });

  it("reads a block over MAX_BLOCK_BYTES in 256 px windows of samples, with the same preview (A1)", async () => {
    const buf = geotiffBuffer(700, 600, 3, (b, c, r) => (b * 50 + c + 2 * r) % 300, GEO);
    const { source, reads } = await logged(buf);
    source.block = { ...source.block, bytes: MAX_BLOCK_BYTES + 1 }; // stands in for a 6000 px single strip
    const p = await buildPreview(source, 1024);
    expect(reads.map((r) => `${r.x0},${r.y0} ${r.w}x${r.h}`)).toEqual(tileWindows(700, 600).map((w) => `${w.x0},${w.y0} ${w.width}x${w.height}`));
    const before = await buildPreview(windowsOnly(await openGeoTiff(await fromArrayBuffer(buf))), 1024);
    expect(Buffer.from(p.rgba).equals(Buffer.from(before.rgba))).toBe(true);
  });

  // a 512 px preview, so every file but the last decimates and the test stays fast (spec 029): tiles, strips, a single strip, nodata
  it("leaves the previews of files without overviews unchanged", async () => {
    const files = [
      uint8Tiff([{ width: 1300, height: 700, bands: 3, value: v, layout: { tile: [256, 256] } }], GEO),
      uint8Tiff([{ width: 700, height: 900, bands: 1, value: v, layout: { rows: 7 } }], GEO),
      geotiffBuffer(600, 600, 3, (b, c, r) => (b === 0 ? (c < 300 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150), { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }),
      geotiffBuffer(300, 200, 2, (b, c, r) => (c === 5 ? -9 : b * 1000 + r * 0.5 + c), { ...GEO, nodata: "-9" }),
    ];
    for (const buf of files) {
      const { source } = await logged(buf);
      const now = await buildPreview(source, 512);
      const before = await buildPreview(windowsOnly(await openGeoTiff(await fromArrayBuffer(buf))), 512);
      expect(now.corners).toEqual(before.corners);
      expect(now.ranges).toEqual(before.ranges);
      expect(Buffer.from(now.rgba).equals(Buffer.from(before.rgba))).toBe(true);
    }
  });
});

// Spec 025 keeps up to 4 of these reads in flight, so a read may start before the previous one finishes.
describe("progress and abort on the sample reads (spec 019 criteria 1 and 3, after spec 020 and 025)", () => {
  const files: [string, ArrayBuffer][] = [
    ["blocks", uint8Tiff([{ width: 2500, height: 1300, bands: 3, value: v, layout: { tile: [256, 256] } }], GEO)],
    ["an overview", uint8Tiff(withOverviews(4100, 3000, 3, v, [2, 4], [256, 256]), GEO)],
  ];

  it.each(files)("reports once per sample read through %s, done 1..total in order, and passes the signal", async (_n, buf) => {
    const { source, reads } = await logged(buf);
    const signals: (AbortSignal | undefined)[] = [];
    const inner = source.readSamples;
    source.readSamples = (...a) => { signals.push(a[6]); return inner(...a); };
    const ac = new AbortController();
    const calls: [number, number, number][] = [];
    await buildPreview(source, 1024, { signal: ac.signal, onProgress: (d, t) => calls.push([d, t, reads.length]) });
    expect(reads.length).toBeGreaterThan(1);
    expect(calls.map(([d, t]) => [d, t])).toEqual(reads.map((_, i) => [i + 1, reads.length]));
    expect(calls.every(([d, , started]) => started >= d && started <= d + 3)).toBe(true);
    expect(signals.every((s) => s === ac.signal)).toBe(true);
  });

  it.each(files)("an abort during sample read 3 of %s starts no read after it and rejects with AbortError", async (_n, buf) => {
    const { source, reads } = await logged(buf);
    const ac = new AbortController();
    const inner = source.readSamples;
    let finished = 0, startedAtAbort = 0;
    source.readSamples = async (...a) => { const r = await inner(...a); if (++finished === 3) { ac.abort(); startedAtAbort = reads.length; } return r; };
    await expect(buildPreview(source, 1024, { signal: ac.signal })).rejects.toSatisfy((e) => (e as Error).name === "AbortError");
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toHaveLength(startedAtAbort);
    expect(startedAtAbort).toBeLessThanOrEqual(6);
  });
});
