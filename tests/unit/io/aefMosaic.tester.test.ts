import { GeoTIFFImage } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { TILE_SIZE } from "../../../src/core/types";
import { memoryStore, WINDOW_BYTES, type CacheStore } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
import { aefTiff, memFetch, pattern, type AefTiffSpec } from "../helpers/aefTiff";

// Tester tests (spec 002 criteria 7, 12 and the tile-by-tile rule) on synthetic COGs.
const BASE = "https://aef.test/v1/annual/";
const OX = 500000, OY = 2800000; // global pixel origin for the value pattern
const deq = (v: number) => (v === -128 ? NaN : Math.fround((v * Math.abs(v)) / (127.5 * 127.5)));

type Cog = { entry: AefEntry; bytes: Uint8Array };
let n = 0;
/** COG with north-west corner (x0, y1) whose pixels follow the global pattern unless `value` overrides. */
function cog(x0: number, y1: number, width: number, height: number, o: Partial<AefTiffSpec> = {}): Cog {
  const gx0 = (x0 - OX) / 10, gy0 = (OY - y1) / 10;
  const bytes = aefTiff({ width, height, x0, y1, tile: 64, value: (b, r, c) => pattern(b, gx0 + c, gy0 + r), ...o });
  const path = `2021/17N/syn-${n++}.tiff`;
  return { entry: { year: 2021, epsg: 32617, path, x0, y0: y1 - 10 * height, x1: x0 + 10 * width, y1 }, bytes };
}
const serve = (cogs: Cog[]) => new Map(cogs.map((c) => [BASE + c.entry.path, c.bytes]));
const aoiAt = (x0: number, y1: number, width: number, height: number): Aoi => ({ epsg: 32617, gt: [x0, 10, 0, y1, 0, -10], width, height });

/** Compare every cached pixel with `want(band, aoiRow, aoiCol)`; returns the first mismatch or null. */
async function mismatch(aoi: Aoi, store: CacheStore, cogs: Cog[], want: (b: number, r: number, c: number) => number) {
  const src = await fetchEntries(aoi, cogs.map((c) => c.entry), store, { fetch: memFetch(serve(cogs)).fetch, base: BASE });
  for (const w of tileWindows(aoi.width, aoi.height)) {
    const t = await src.readWindow(w.x0, w.y0, w.width, w.height);
    for (let b = 0; b < AEF_BANDS; b += 7) for (let r = 0; r < w.height; r++) for (let c = 0; c < w.width; c++) {
      const got = t.bands[b]![r * w.width + c]!, exp = want(b, w.y0 + r, w.x0 + c);
      if (!(got === exp || (Number.isNaN(got) && Number.isNaN(exp)))) return { b, r: w.y0 + r, c: w.x0 + c, got, exp };
    }
  }
  return null;
}
/** Expected value from the global pattern for an AOI pixel, NaN where `covered` says no COG. */
const fromPattern = (aoi: Aoi, covered: (gx: number, gy: number) => boolean) => (b: number, r: number, c: number) => {
  const gx = (aoi.gt[0] - OX) / 10 + c, gy = (OY - aoi.gt[3]) / 10 + r;
  return covered(gx, gy) ? deq(pattern(b, gx, gy)) : NaN;
};

afterEach(() => vi.restoreAllMocks());

describe("mosaic orientation and partial windows (tester, criterion 7)", () => {
  it.each([true, false])("bottomUp=%s COG larger than the AOI, AOI inside it with partial edge windows", async (bottomUp) => {
    const c = cog(OX, OY, 600, 560, { bottomUp });
    const aoi = aoiAt(OX + 370, OY - 230, 300, 290); // AOI cols 37..336, rows 23..312 of the COG
    expect(await mismatch(aoi, memoryStore(), [c], fromPattern(aoi, () => true))).toBeNull();
  });

  it("AOI extending past a bottom-up COG's north-west corner is NaN outside it", async () => {
    const c = cog(OX, OY, 200, 150, { bottomUp: true });
    const aoi = aoiAt(OX - 300, OY + 170, 290, 270);
    expect(await mismatch(aoi, memoryStore(), [c], fromPattern(aoi, (gx, gy) => gx >= 0 && gx < 200 && gy >= 0 && gy < 150))).toBeNull();
  });

  it("four mixed-orientation COGs with a 3-column gap between them: the gap is NaN", async () => {
    const cogs = [
      cog(OX, OY, 100, 120, { bottomUp: true }), cog(OX + 1030, OY, 90, 120),
      cog(OX, OY - 1200, 100, 80), cog(OX + 1030, OY - 1200, 90, 80, { bottomUp: true }),
    ];
    const aoi = aoiAt(OX, OY, 193, 200);
    expect(await mismatch(aoi, memoryStore(), cogs, fromPattern(aoi, (gx) => gx < 100 || gx >= 103))).toBeNull();
  });

  it("an AOI of one pixel at a COG's last row and column", async () => {
    const c = cog(OX, OY, 70, 50, { bottomUp: true });
    const aoi = aoiAt(OX + 690, OY - 490, 1, 1);
    expect(await mismatch(aoi, memoryStore(), [c], fromPattern(aoi, () => true))).toBeNull();
  });

  it("the result does not depend on index order for overlapping COGs with equal values", async () => {
    const a = cog(OX, OY, 200, 200, { bottomUp: true }), b = cog(OX + 1000, OY - 500, 200, 200);
    const aoi = aoiAt(OX, OY, 300, 250);
    const cover = (gx: number, gy: number) => (gx < 200 && gy < 200) || (gx >= 100 && gy >= 50 && gy < 250);
    expect(await mismatch(aoi, memoryStore(), [a, b], fromPattern(aoi, cover))).toBeNull();
    expect(await mismatch(aoi, memoryStore(), [b, a], fromPattern(aoi, cover))).toBeNull();
  });

  // FOLLOW-UP (tester): a later COG's no-data (-128) overwrites an earlier COG's valid pixels,
  // so a covered pixel turns NaN depending on index order. Flip to `it` once fixed.
  it.fails("BUG: no data in an overlapping COG does not erase another COG's valid pixels", async () => {
    const a = cog(OX, OY, 200, 200);
    const b = cog(OX + 1000, OY, 200, 200, { value: (bd, r, c) => (c < 100 ? -128 : pattern(bd, 100 + c, r)) }); // padded west half
    const aoi = aoiAt(OX, OY, 300, 200);
    expect(await mismatch(aoi, memoryStore(), [a, b], fromPattern(aoi, () => true))).toBeNull();
  });
});

describe("grid refusal (tester, criterion 7)", () => {
  const good = () => cog(OX, OY, 100, 100);
  it.each([
    ["5 m off in y, bottom-up", () => cog(OX + 1000, OY - 5, 100, 100, { bottomUp: true })],
    ["5 m off in x, first in the list", () => cog(OX + 1005, OY, 100, 100)],
    ["1 m off", () => cog(OX + 1001, OY, 100, 100)],
    ["20 m pixels", () => cog(OX + 1000, OY, 50, 50, { scaleX: 20, scaleY: 20 })],
    ["10 x 20 m pixels", () => cog(OX + 1000, OY, 100, 50, { scaleY: 20 })],
    ["another UTM zone", () => cog(OX + 1000, OY, 100, 100, { epsg: 32618 })],
  ])("refuses a COG %s before writing anything, and discards the cache", async (name, make) => {
    const bad = make(), ok = good();
    const list = name.includes("first") ? [bad, ok] : [ok, bad];
    const store = memoryStore();
    const aoi = aoiAt(OX, OY, 200, 100);
    await expect(fetchEntries(aoi, list.map((c) => c.entry), store, { fetch: memFetch(serve(list)).fetch, base: BASE }))
      .rejects.toThrow(`AlphaEarth file ${bad.entry.path} is not on the area's 10 m grid.`);
    expect(store.writes).toBe(0);
    expect(store.discarded).toBe(true);
  });

  it("accepts a COG offset by a whole number of pixels from the AOI origin", async () => {
    const c = cog(OX + 10, OY - 10, 100, 100);
    const aoi = aoiAt(OX, OY, 120, 120);
    expect(await mismatch(aoi, memoryStore(), [c], fromPattern(aoi, (gx, gy) => gx >= 1 && gx < 101 && gy >= 1 && gy < 101))).toBeNull();
  });

  it("refuses a COG without 64 bands (band-count mismatch) and discards the cache", async () => {
    const c = cog(OX, OY, 40, 40, { bands: 3 });
    const store = memoryStore();
    await expect(fetchEntries(aoiAt(OX, OY, 40, 40), [c.entry], store, { fetch: memFetch(serve([c])).fetch, base: BASE }))
      .rejects.toThrow(`AlphaEarth file ${c.entry.path} has 3 bands, not 64.`);
    expect(store.discarded).toBe(true);
  });
});

describe("no data -128 (tester, criterion 7)", () => {
  it("-128 in some bands of a pixel is NaN in those bands only", async () => {
    const c = cog(OX, OY, 30, 30, { value: (b, r, cc) => (r === 3 && cc === 4 && b % 2 === 0 ? -128 : pattern(b, cc, r)) });
    const aoi = aoiAt(OX, OY, 30, 30);
    const want = (b: number, r: number, cc: number) => (r === 3 && cc === 4 && b % 2 === 0 ? NaN : deq(pattern(b, cc, r)));
    expect(await mismatch(aoi, memoryStore(), [c], want)).toBeNull();
  });

  it("an all-no-data COG gives an all-NaN AOI, and the cache source's nodata is null", async () => {
    const c = cog(OX, OY, 30, 30, { value: () => -128 });
    const store = memoryStore();
    const src = await fetchEntries(aoiAt(OX, OY, 30, 30), [c.entry], store, { fetch: memFetch(serve([c])).fetch, base: BASE });
    expect(src.meta.nodata).toBeNull();
    const t = await src.readWindow(0, 0, 30, 30);
    expect(t.nodata).toBeNull();
    expect(t.bands.every((b) => b.every(Number.isNaN))).toBe(true);
  });
});

describe("tile-by-tile memory rule (tester, structural)", () => {
  /** Store that records window indices and sizes without keeping the data. */
  function countingStore() {
    const writes: { i: number; bytes: number }[] = [];
    return {
      writes, discarded: false,
      async write(i: number, d: Int8Array) { writes.push({ i, bytes: d.length }); },
      async read(): Promise<Int8Array> { throw new Error("not kept"); },
      async discard() { this.discarded = true; },
    };
  }

  it("every COG read window lies inside the file and is at most 256x256; every cache window is one 4 MiB write", async () => {
    const spy = vi.spyOn(GeoTIFFImage.prototype, "readRasters");
    const cogs = [cog(OX, OY, 520, 300, { bottomUp: true }), cog(OX + 5200, OY, 300, 300)];
    const aoi = aoiAt(OX + 50, OY - 30, 700, 270);
    const store = countingStore();
    await fetchEntries(aoi, cogs.map((c) => c.entry), store, { fetch: memFetch(serve(cogs)).fetch, base: BASE });
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const [opts] of spy.mock.calls) {
      const [c0, r0, c1, r1] = (opts as { window: number[] }).window as [number, number, number, number];
      expect(c1 - c0).toBeGreaterThan(0); expect(c1 - c0).toBeLessThanOrEqual(TILE_SIZE);
      expect(r1 - r0).toBeGreaterThan(0); expect(r1 - r0).toBeLessThanOrEqual(TILE_SIZE);
      expect(c0).toBeGreaterThanOrEqual(0); expect(r0).toBeGreaterThanOrEqual(0);
      expect(c1).toBeLessThanOrEqual(520); expect(r1).toBeLessThanOrEqual(300);
    }
    const across = Math.ceil(700 / 256), down = Math.ceil(270 / 256);
    expect(store.writes.map((w) => w.i)).toEqual(Array.from({ length: across * down }, (_, i) => i)); // row-major, once each
    for (const w of store.writes) expect(w.bytes).toBe(WINDOW_BYTES);
    expect(WINDOW_BYTES).toBe(4 * 2 ** 20);
  });

  it("at MAX_AOI_SIDE (2048x2048) the download is 64 window writes of 4 MiB and no read exceeds 256x256", async () => {
    const spy = vi.spyOn(GeoTIFFImage.prototype, "readRasters");
    const cogs = [cog(OX + 20000, OY - 20000, 80, 80), cog(OX, OY, 64, 64, { bottomUp: true })]; // far corner and origin
    const aoi = aoiAt(OX, OY, 2048, 2048);
    const store = countingStore();
    await fetchEntries(aoi, cogs.map((c) => c.entry), store, { fetch: memFetch(serve(cogs)).fetch, base: BASE });
    expect(store.writes.map((w) => w.i)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    for (const w of store.writes) expect(w.bytes).toBe(WINDOW_BYTES);
    for (const [opts] of spy.mock.calls) {
      const [c0, r0, c1, r1] = (opts as { window: number[] }).window as number[];
      expect(c1! - c0!).toBeLessThanOrEqual(TILE_SIZE); expect(r1! - r0!).toBeLessThanOrEqual(TILE_SIZE);
    }
  });

  it("the cache source refuses reads larger than one 256x256 window or past the AOI edge", async () => {
    const c = cog(OX, OY, 300, 300);
    const src = await fetchEntries(aoiAt(OX, OY, 300, 300), [c.entry], memoryStore(), { fetch: memFetch(serve([c])).fetch, base: BASE });
    await expect(src.readWindow(0, 0, 300, 300)).rejects.toThrow(/256x256/);
    await expect(src.readWindow(0, 0, 512, 256)).rejects.toThrow(/256x256/);
    await expect(src.readWindow(256, 256, 256, 256)).rejects.toThrow(/256x256/); // past the 300 px edge
    expect((await src.readWindow(256, 256, 44, 44)).bands).toHaveLength(64);
  });
});
