import { describe, expect, it } from "vitest";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import type { Window } from "../../../src/core/grid";
import { decodedBytes, MAX_READ_BYTES, type Block, type Level } from "../../../src/core/imagery";
import { maskBit, nodataMask } from "../../../src/core/nodata";
import { seedWindows } from "../../../src/core/seed";
import type { Affine, Grid } from "../../../src/core/types";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { ImageryLoader } from "../../../src/io/imageryLoader";
import type { LabelSource } from "../../../src/io/labelFile";
import { windowLabels } from "../../../src/io/maskBase";
import { buildPreview } from "../../../src/io/pipeline";
import { importLabels } from "../../../src/io/seeding";
import type { ImagerySource, RasterSource } from "../../../src/io/source";
import { effectiveTiles } from "../helpers/effective";
import { fakeLabelSource } from "../helpers/labelFiles";
import { geotiffBuffer, samplesSource } from "../helpers/sources";
import { uint8Tiff } from "../helpers/tiffFixtures";

// Spec 022 criteria 2 (openGeoTiff), 4 (preview, io), 7 (bands read), 8 (spec 021's skip, amended) and 9 (rule R).

const gt: Affine = [500000, 10, 0, 5000000, 0, -10];
const GEO = { epsg: 32633, gt };
const open = async (buf: ArrayBuffer) => openGeoTiff(await fromArrayBuffer(buf));
/** RGBA: transparent black for c < 16, else visible RGB 100..200. */
const rgbaValue = (k: number, c: number, r: number) => (c < 16 ? 0 : k === 3 ? 255 : 100 + ((c + r + k) % 101));

describe("openGeoTiff alpha (criterion 2)", () => {
  it("an RGBA uint8 file with ExtraSamples 2 has alpha 3", async () => {
    const src = await open(uint8Tiff([{ width: 64, height: 64, bands: 4, value: rgbaValue, layout: { rows: 1 }, extraSamples: [2] }], GEO));
    expect(src.meta.alpha).toBe(3);
    const t = await src.readWindow(0, 0, 64, 64);
    expect(t.alpha).toBe(3);
    const m = nodataMask(t);
    expect([maskBit(m, 0), maskBit(m, 15), maskBit(m, 16)]).toEqual([1, 1, 0]);
  });

  it("a 4-band uint16 file with ExtraSamples 0 and nodata 256 has none, and masks by nodata as before", async () => {
    const v = new Uint16Array(32 * 32 * 4);
    for (let p = 0; p < 32 * 32; p++) for (let k = 0; k < 4; k++) v[p * 4 + k] = p % 10 === 0 ? 256 : k === 3 ? 0 : 100 + k;
    const buf = writeArrayBuffer(v, { width: 32, height: 32, SamplesPerPixel: 4, ExtraSamples: [0], ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 500000, 5000000, 0], GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32633, GDAL_NODATA: "256" });
    const src = await open(buf);
    expect([src.meta.alpha, src.meta.nodata]).toEqual([null, 256]);
    const m = nodataMask(await src.readWindow(0, 0, 32, 32));
    expect([maskBit(m, 0), maskBit(m, 1), maskBit(m, 10)]).toEqual([1, 0, 1]); // band 4 is 0 but isn't alpha
  });

  it("the existing RGB fixtures have none", async () => {
    expect((await open(geotiffBuffer(10, 10, 3, () => 1, GEO))).meta.alpha).toBeNull();
    expect((await open(geotiffBuffer(10, 10, 4, () => 1, GEO))).meta.alpha).toBeNull();
    expect((await open(uint8Tiff([{ width: 10, height: 10, bands: 3, value: () => 1, layout: { tile: [16, 16] } }], GEO))).meta.alpha).toBeNull();
  });
});

/** The GeoTIFF source with its sample reads logged. */
async function logged(buf: ArrayBuffer) {
  const src = await open(buf);
  const bands: number[][] = [];
  const source: ImagerySource = { ...src, readSamples: (i, x0, y0, w, h, b, s) => { bands.push([...b]); return src.readSamples(i, x0, y0, w, h, b, s); } };
  return { source, bands };
}

describe("preview with alpha (criteria 4 and 7)", () => {
  it("draws transparent pixels with alpha 0 and stretches over visible pixels only, reading [0, 1, 2, 3]", async () => {
    const { source, bands } = await logged(uint8Tiff([{ width: 64, height: 64, bands: 4, value: rgbaValue, layout: { rows: 1 }, extraSamples: [2] }], GEO));
    const p = await buildPreview(source, 64);
    expect(p.ranges).toEqual([[100, 200], [100, 200], [100, 200]]);
    const mid = Math.floor(p.height / 2);
    expect(p.rgba[4 * (mid * p.width) + 3]).toBe(0); // the west edge is transparent
    expect(p.rgba[4 * (mid * p.width + p.width - 1) + 3]).toBe(255);
    expect(bands.length).toBeGreaterThan(0);
    expect(bands.every((b) => b.join() === "0,1,2,3")).toBe(true);
  });

  it("reads [0, 1] for gray plus alpha", async () => {
    const { source, bands } = await logged(uint8Tiff([{ width: 64, height: 64, bands: 2, value: (k, c) => (k === 1 ? (c < 16 ? 0 : 255) : 120), layout: { tile: [16, 16] }, extraSamples: [2] }], GEO));
    expect(source.meta.alpha).toBe(1);
    const p = await buildPreview(source, 64);
    expect(bands.every((b) => b.join() === "0,1")).toBe(true);
    const mid = Math.floor(p.height / 2);
    expect(p.rgba[4 * (mid * p.width) + 3]).toBe(0);
  });
});

describe("full-resolution tiles with alpha (criterion 7)", () => {
  const W = 22300, H = 512;
  const GRID: Grid = { width: W, height: H, epsg: 32633, gt };
  const level: Level = { s: 1, grid: GRID, overview: null };
  for (const [bandCount, alpha, want] of [[4, 3, "0,1,2,3"], [2, 1, "0,1"]] as const) {
    it(`asks for [${want}] with ${bandCount} bands, each read within MAX_READ_BYTES of 1-row strips`, async () => {
      const block: Block = { width: W, height: 1, bytes: W * bandCount };
      const { source, reads } = samplesSource({ ...GRID, bandCount, alpha, float: false }, (k, c) => (k === alpha ? (c < 300 ? 0 : 255) : 90), block);
      const drawn = new Map<string, Uint8ClampedArray>();
      const loader = new ImageryLoader(source, [[0, 180], [0, 180], [0, 180]], { use: (k) => drawn.has(k), draw: (k, _l, _t, rgba) => { drawn.set(k, rgba.slice()); } });
      const tiles: Window[] = [0, 256, 512].map((x0) => ({ x0, y0: 0, width: 256, height: 256 }));
      loader.show({ level, tiles });
      await expect.poll(() => drawn.size).toBe(3);
      expect(reads.every((r) => r.bands.join() === want)).toBe(true);
      expect(reads.every((r) => decodedBytes(r, block, W, H) <= MAX_READ_BYTES)).toBe(true);
      const t0 = drawn.get("1-0,0")!, t1 = drawn.get("1-256,0")!;
      expect([t0[3], t0[4 * 255 + 3], t1[4 * 255 + 3]]).toEqual([0, 0, 255]); // pixel 255 of tile 0 is c 255 (< 300); of tile 1, c 511
    });
  }
});

// Rule R and the skip, on an equal grid; the mask labels every pixel, the imagery is transparent for c < 100 and in a block at 600..700, 300..400.
const G: Grid = { width: 1000, height: 700, epsg: 32633, gt };
const clear = (c: number, r: number) => c < 100 || (c >= 600 && c < 700 && r >= 300 && r < 400);
const imageryValue = (k: number, c: number, r: number) => (k === 3 ? (clear(c, r) ? 0 : 200) : (c * 7 + r * 3 + k) % 250);
const maskValue = (c: number, r: number) => 1 + ((c >> 5) + (r >> 5)) % 3;
const TABLE = [1, 2, 3].map((v) => ({ value: v, name: `v${v}` }));

describe("spec 021's skip with alpha (criterion 8)", () => {
  it("with alpha, no nodata and integer samples windowLabels reads only the alpha sample, with tiles equal to a full read", async () => {
    const block: Block = { width: 256, height: 256, bytes: 256 * 256 * 4 };
    const { source, reads } = samplesSource({ ...G, bandCount: 4, alpha: 3, float: false }, imageryValue, block);
    const full = samplesSource({ ...G, bandCount: 4, alpha: 3, float: false }, imageryValue, block, true).source;
    const windowsOnly: RasterSource = { meta: full.meta, readWindow: full.readWindow };
    const file = fakeLabelSource(G, maskValue).source;
    const lut = new Uint8Array(256); lut[1] = 1; lut[2] = 2; lut[3] = 3;
    for (const w of [{ x0: 0, y0: 0, width: 256, height: 256 }, { x0: 512, y0: 256, width: 256, height: 256 }]) {
      const a = (await windowLabels(source, file, lut, w))!, b = (await windowLabels(windowsOnly, file, lut, w))!;
      expect(Buffer.from(a.labels).equals(Buffer.from(b.labels))).toBe(true);
      expect(a.labels.some((v) => v === 0)).toBe(true);
    }
    expect(reads.map((r) => r.bands.join())).toEqual(["3", "3"]);
  });

  it("with no alpha, integer samples and no nodata, nothing is read (spec 021 criterion 9)", async () => {
    const { source, reads } = samplesSource({ ...G, bandCount: 3, alpha: null, float: false }, imageryValue, { width: 256, height: 256, bytes: 196608 });
    const r = await importLabels(source, fakeLabelSource(G, maskValue).source, TABLE);
    expect(typeof r).toBe("object");
    expect(reads).toEqual([]);
  });
});

describe("rule R: an import's imagery reads, one row of seed windows at a time (criterion 9)", () => {
  const strips = (bytes: number): Block => ({ width: G.width, height: 1, bytes });
  for (const [name, meta, block, rowsRead] of [
    ["alpha only, 1-row strips", { alpha: 3, nodata: null, float: false }, strips(G.width * 4), 3],
    ["alpha only, strips split by MAX_READ_BYTES", { alpha: 3, nodata: null, float: false }, strips(200_000), null],
    ["alpha and nodata, 256 tiles", { alpha: 3, nodata: 7, float: false }, { width: 256, height: 256, bytes: 256 * 256 * 4 }, 3],
  ] as const) {
    it(`reads rows of seed windows within the limit, each block once per row, with tiles equal to unbatched reads (${name})`, { timeout: 60_000 }, async () => {
      const m = { ...G, bandCount: 4, ...meta };
      const { source, reads } = samplesSource(m, imageryValue, block);
      const file = fakeLabelSource(G, maskValue).source;
      const r = await importLabels(source, file, TABLE);
      if (typeof r === "string") throw new Error(r);
      const imported = reads.splice(0);
      expect(imported.length).toBeGreaterThan(0);
      if (rowsRead) expect(imported).toHaveLength(rowsRead);
      expect(imported.every((x) => x.bands.join() === (meta.nodata === null ? "3" : "0,1,2,3"))).toBe(true);
      const decoded = new Set<string>();
      for (const x of imported) {
        const row = Math.floor(x.y0 / 256);
        expect(Math.floor((x.y0 + x.height - 1) / 256)).toBe(row); // one row of seed windows, or part of one
        expect(decodedBytes(x, block, G.width, G.height)).toBeLessThanOrEqual(MAX_READ_BYTES);
        for (let by = Math.floor(x.y0 / block.height); by < Math.ceil((x.y0 + x.height) / block.height); by++)
          for (let bx = Math.floor(x.x0 / block.width); bx < Math.ceil((x.x0 + x.width) / block.width); bx++) {
            const k = `${row}:${bx},${by}`;
            expect(decoded.has(k), k).toBe(false);
            decoded.add(k);
          }
      }
      const plain = samplesSource(m, imageryValue, block, true).source;
      const windowsOnly: RasterSource = { meta: plain.meta, readWindow: plain.readWindow };
      const u = await importLabels(windowsOnly, file, TABLE);
      if (typeof u === "string") throw new Error(u);
      expect(r.pixels).toBe(u.pixels);
      expect(r.pixels).toBeLessThan(G.width * G.height);
      const a = await effectiveTiles(source, r), b = await effectiveTiles(windowsOnly, u);
      for (const [k, t] of b) expect(Buffer.from(a.get(k)!).equals(Buffer.from(t)), k).toBe(true);
      expect([...r.base.preview.values]).toEqual([...u.base.preview.values]);
    });
  }
});

describe("Cancel under rule R (spec 021 criterion 5, amended)", () => {
  it("reads no file window after k + 1 and no imagery after the current row", async () => {
    const { source, reads } = samplesSource({ ...G, bandCount: 4, alpha: 3, float: false }, imageryValue, { width: G.width, height: 1, bytes: G.width * 4 });
    const f = fakeLabelSource(G, maskValue);
    let cancelled = false;
    const calls: number[] = [];
    const r = await importLabels(source, f.source, TABLE, () => cancelled, (d) => { calls.push(d); if (d === 2) cancelled = true; });
    expect(r).toBe("stale");
    expect(calls).toEqual([1, 2]);
    const row0 = seedWindows(G, G).filter((w) => w.y0 === 0).map((w) => `${w.x0},${w.y0}`);
    expect(f.reads.every((w) => row0.includes(`${w.x0},${w.y0}`))).toBe(true);
    expect(reads.every((x) => x.y0 + x.height <= 256)).toBe(true);
  });

  it("a Cancel during a row's file reads reads no imagery for it", async () => {
    const { source, reads } = samplesSource({ ...G, bandCount: 4, alpha: 3, float: false }, imageryValue, { width: G.width, height: 1, bytes: G.width * 4 });
    const f = fakeLabelSource(G, maskValue).source;
    let n = 0, cancelled = false;
    const file: LabelSource = { ...f, read: (w) => { if (++n === 2) cancelled = true; return f.read(w); } };
    expect(await importLabels(source, file, TABLE, () => cancelled)).toBe("stale");
    expect(n).toBe(2);
    expect(reads).toEqual([]);
  });
});
