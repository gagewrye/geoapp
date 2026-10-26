import { fromArrayBuffer, GeoTIFFImage } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { memoryStore } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { RangeSource } from "../../../src/io/rangeSource";
import { aefTiff, memFetch, pattern } from "../helpers/aefTiff";

// Tester re-verification of the band-group redesign (spec 002 Cache, review issue 1):
// passes never refetch a band-separate tile, interleaved and mixed AOIs fall back to one pass,
// and the per-COG bound on held compressed tiles and decoded tiles per read holds structurally.
const BASE = "https://aef.test/v1/annual/";
const OX = 500000, OY = 2800000;
const deq = (v: number) => Math.fround((v * Math.abs(v)) / (127.5 * 127.5));

type Spec = { name: string; gx0: number; gy0: number; width: number; height: number; tile: number; bottomUp?: boolean; interleaved?: boolean };
type Cog = { s: Spec; bytes: Uint8Array; entry: AefEntry; band: Map<number, number> };

/** Deflated synthetic COG at global pixel (gx0, gy0), with each tile offset mapped to its band. */
async function make(s: Spec): Promise<Cog> {
  const x0 = OX + 10 * s.gx0, y1 = OY - 10 * s.gy0;
  const bytes = aefTiff({
    width: s.width, height: s.height, x0, y1, tile: s.tile, bottomUp: s.bottomUp, interleaved: s.interleaved, deflate: true,
    value: (b, r, c) => pattern(b, s.gx0 + c, s.gy0 + r),
  });
  const img = await (await fromArrayBuffer(bytes.slice().buffer)).getImage();
  const offsets = Array.from(await img.fileDirectory.loadValue("TileOffsets") as ArrayLike<number>, Number);
  const perBand = offsets.length / (s.interleaved ? 1 : AEF_BANDS);
  const band = new Map(offsets.map((o, i) => [o, s.interleaved ? -1 : Math.floor(i / perBand)]));
  const entry: AefEntry = { year: 2021, epsg: 32617, path: `2021/17N/${s.name}.tiff`, x0, y0: y1 - 10 * s.height, x1: x0 + 10 * s.width, y1 };
  return { s, bytes, entry, band };
}

/** Distinct tile columns of a COG overlapping the AOI columns [ax, ax + w) (global pixels). */
function colsAcross(s: Spec, ax: number, w: number) {
  const a = Math.max(ax, s.gx0) - s.gx0, b = Math.min(ax + w, s.gx0 + s.width) - s.gx0;
  return b <= a ? 0 : Math.floor((b - 1) / s.tile) - Math.floor(a / s.tile) + 1;
}

/**
 * Observes every RangeSource through its public plan, fetch and release, and every readRasters
 * call: held planned tiles (fetched and not yet released) per source and their peak, planned
 * tiles fetched per read (geotiff.js decodes each one), and any planned tile fetched again after
 * its release.
 */
function instrument() {
  type Read = { samples: number[]; window: number[]; tiles: { src: RangeSource; offset: number }[] };
  const planned = new Map<RangeSource, Map<number, number>>(), held = new Map<RangeSource, Set<number>>();
  const released = new Map<RangeSource, Set<number>>(), peak = new Map<RangeSource, number>();
  const reads: Read[] = [];
  const refetched: number[] = [];
  let current: Read | null = null;
  const { plan, fetch, release } = RangeSource.prototype;
  vi.spyOn(RangeSource.prototype, "plan").mockImplementation(function (this: RangeSource, offset: number, length: number) {
    if (!planned.has(this)) { planned.set(this, new Map()); held.set(this, new Set()); released.set(this, new Set()); }
    planned.get(this)!.set(offset, length);
    plan.call(this, offset, length);
  });
  vi.spyOn(RangeSource.prototype, "fetch").mockImplementation(function (this: RangeSource, sl: { offset: number; length: number }[], signal?: AbortSignal) {
    const h = held.get(this);
    if (h) {
      for (const x of sl) {
        if (planned.get(this)!.get(x.offset) !== x.length) continue;
        if (released.get(this)!.has(x.offset)) refetched.push(x.offset);
        h.add(x.offset);
        current?.tiles.push({ src: this, offset: x.offset });
      }
      peak.set(this, Math.max(peak.get(this) ?? 0, h.size));
    }
    return fetch.call(this, sl, signal);
  });
  vi.spyOn(RangeSource.prototype, "release").mockImplementation(function (this: RangeSource, offset: number) {
    if (held.get(this)?.delete(offset)) released.get(this)!.add(offset);
    release.call(this, offset);
  });
  const rr = GeoTIFFImage.prototype.readRasters;
  vi.spyOn(GeoTIFFImage.prototype, "readRasters").mockImplementation(async function (this: GeoTIFFImage, ...args: Parameters<typeof rr>) {
    const o = args[0] as { samples: number[]; window: number[] };
    const r: Read = { samples: o.samples, window: o.window, tiles: [] };
    // fetchEntries reads one COG window at a time, so the tiles fetched in between belong to this read
    expect(current).toBeNull();
    current = r;
    try { return await rr.apply(this, args); } finally { reads.push(r); current = null; }
  });
  return { held, peak, reads, refetched };
}

/** Each byte of each file was requested at most once (no tile fetched twice in any pass). */
function eachByteOnce(files: Map<string, Uint8Array>, log: { url: string; range: [number, number] | null }[]) {
  for (const [url, data] of files) {
    const ranges = log.filter((l) => l.url === url).map((l) => [l.range![0], Math.min(l.range![1], data.length - 1)] as const);
    const seen = new Uint8Array(data.length);
    for (const [a, b] of ranges) seen.fill(1, a, b + 1);
    expect(ranges.reduce((t, [a, b]) => t + b - a + 1, 0), url).toBe(seen.reduce((t, v) => t + v, 0));
  }
}

async function run(specs: Spec[], [ax, ay, w, h]: [number, number, number, number]) {
  const cogs = await Promise.all(specs.map(make));
  expect(new Set(cogs.map((c) => c.bytes.length)).size, "file sizes tell the COGs apart").toBe(cogs.length);
  const files = new Map(cogs.map((c) => [BASE + c.entry.path, c.bytes]));
  const probe = instrument();
  const { fetch, log } = memFetch(files);
  const aoi: Aoi = { epsg: 32617, gt: [OX + 10 * ax, 10, 0, OY - 10 * ay, 0, -10], width: w, height: h };
  const src = await fetchEntries(aoi, cogs.map((c) => c.entry), memoryStore(), { fetch, base: BASE });
  vi.restoreAllMocks();
  const cogOf = (s: RangeSource) => cogs.find((c) => c.bytes.length === s.fileSize)!;
  return { cogs, files, log, src, probe, cogOf, aoi };
}

/** Pixels of some bands across every window equal the pattern; NaN outside every COG. */
async function pixelsRight(r: Awaited<ReturnType<typeof run>>, [ax, ay, w, h]: number[], step = 29) {
  for (const win of tileWindows(w!, h!)) {
    const t = await r.src.readWindow(win.x0, win.y0, win.width, win.height);
    for (const b of [0, 7, 8, 40, 63]) for (let y = 0; y < win.height; y += step) for (let x = 0; x < win.width; x += step) {
      const gx = ax! + win.x0 + x, gy = ay! + win.y0 + y;
      const inside = r.cogs.some(({ s }) => gx >= s.gx0 && gx < s.gx0 + s.width && gy >= s.gy0 && gy < s.gy0 + s.height);
      const v = t.bands[b]![y * win.width + x]!;
      if (inside) expect(v, `band ${b} at ${gx},${gy}`).toBe(deq(pattern(b, gx, gy))); else expect(v).toBeNaN();
    }
  }
}

const groups = (k: number) => Array.from({ length: AEF_BANDS / k }, (_, g) => Array.from({ length: k }, (_, i) => g * k + i).join(","));

afterEach(() => vi.restoreAllMocks());

describe("band-group passes (tester, spec 002 Cache)", () => {
  it("two band-separate COGs: 8 passes, every read fetches only its pass's bands, no tile is fetched twice or after release", async () => {
    const box: [number, number, number, number] = [40, 30, 600, 400];
    const r = await run([
      { name: "w", gx0: 0, gy0: 0, width: 330, height: 500, tile: 96, bottomUp: true },
      { name: "e", gx0: 330, gy0: 0, width: 400, height: 500, tile: 128 },
    ], box);
    expect(new Set(r.probe.reads.map((x) => x.samples.join(",")))).toEqual(new Set(groups(BAND_GROUP)));
    // passes in band order, windows row-major inside each
    const passOrder = r.probe.reads.map((x) => x.samples[0]! / BAND_GROUP);
    expect(passOrder).toEqual([...passOrder].sort((a, b) => a - b));
    for (const read of r.probe.reads) for (const t of read.tiles) expect(read.samples).toContain(r.cogOf(t.src).band.get(t.offset));
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    for (const [, h] of r.probe.held) expect(h.size).toBe(0);
    await pixelsRight(r, box);
  });

  it("mixed AOI (one pixel-interleaved COG, one band-separate): one pass of 64 bands, no tile fetched twice, pixels right", async () => {
    const box: [number, number, number, number] = [20, 10, 500, 300];
    const r = await run([
      { name: "i", gx0: 0, gy0: 0, width: 260, height: 320, tile: 64, interleaved: true },
      { name: "s", gx0: 260, gy0: 0, width: 300, height: 320, tile: 80, bottomUp: true },
    ], box);
    expect(new Set(r.probe.reads.map((x) => x.samples.join(",")))).toEqual(new Set(groups(AEF_BANDS)));
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    for (const [, h] of r.probe.held) expect(h.size).toBe(0);
    await pixelsRight(r, box, 17);
  });

  it("an interleaved-only AOI over several tile rows: one pass, each 64-band tile fetched once and held at most C + 2", async () => {
    const box: [number, number, number, number] = [5, 7, 700, 600];
    const r = await run([{ name: "i2", gx0: 0, gy0: 0, width: 720, height: 640, tile: 288, interleaved: true, bottomUp: true }], box);
    expect(new Set(r.probe.reads.map((x) => x.samples.length))).toEqual(new Set([AEF_BANDS]));
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    for (const [s, n] of r.probe.peak) expect(n).toBeLessThanOrEqual(colsAcross(r.cogOf(s).s, box[0], box[2]) + 2);
    for (const read of r.probe.reads) expect(read.tiles.length).toBeLessThanOrEqual(4);
    await pixelsRight(r, box, 31);
  });
});

describe("memory bound per COG (tester, structural)", () => {
  /** Held compressed tiles per COG: group x (C + ceil(256 / t) x (ceil(256 / t) + 1)); group x (C + 2) from 256 px. */
  const heldBound = (s: Spec, ax: number, w: number) =>
    BAND_GROUP * (colsAcross(s, ax, w) + (s.tile >= 256 ? 2 : Math.ceil(256 / s.tile) * (Math.ceil(256 / s.tile) + 1)));
  /** Decoded tiles under one 256 px window read: group x (tiles a 256 px span can touch)^2. */
  const decodedBound = (s: Spec) => BAND_GROUP * (Math.ceil(255 / s.tile) + 1) ** 2;

  const cases: [string, Spec[], [number, number, number, number]][] = [
    // real AEF layout: band-separate 1024 px tiles; AOI windows straddle the tile edge at global 1024 in both axes
    ["1024 px tiles, windows straddling the tile corner", [{ name: "big", gx0: 0, gy0: 0, width: 2048, height: 2048, tile: 1024, bottomUp: true }], [900, 900, 600, 600]],
    // four COGs meeting at one corner inside a window, 1024 px tiles (one tile per band each)
    ["four 1024 px-tile COGs meeting at a corner inside a window", [
      { name: "nw", gx0: 0, gy0: 0, width: 1024, height: 1024, tile: 1024, bottomUp: true },
      { name: "ne", gx0: 1024, gy0: 0, width: 1000, height: 1024, tile: 1024 },
      { name: "sw", gx0: 0, gy0: 1024, width: 1024, height: 1010, tile: 1024 },
      { name: "se", gx0: 1024, gy0: 1024, width: 990, height: 1000, tile: 1024, bottomUp: true },
    ], [900, 900, 400, 400]],
    ["16 px tiles at an odd offset", [{ name: "t16", gx0: 0, gy0: 0, width: 400, height: 330, tile: 16, bottomUp: true }], [7, 9, 300, 300]],
    ["48 px tiles, AOI past the COG's edges", [{ name: "t48", gx0: 3, gy0: 5, width: 500, height: 520, tile: 48 }], [0, 0, 540, 530]],
    ["300 px tiles, four COGs at a corner", [
      { name: "a", gx0: 0, gy0: 0, width: 600, height: 600, tile: 300 },
      { name: "b", gx0: 600, gy0: 0, width: 610, height: 600, tile: 300, bottomUp: true },
      { name: "c", gx0: 0, gy0: 600, width: 600, height: 620, tile: 300, bottomUp: true },
      { name: "d", gx0: 600, gy0: 600, width: 630, height: 640, tile: 300 },
    ], [450, 470, 600, 560]],
  ];

  it.each(cases)("%s: held tiles and decoded tiles per read within the bound, nothing held at the end, no refetch", async (_n, specs, box) => {
    const r = await run(specs, box);
    expect(r.probe.held.size).toBe(specs.length);
    for (const [s, n] of r.probe.peak) {
      const c = r.cogOf(s);
      expect(n, `${c.s.name} peak held`).toBeLessThanOrEqual(heldBound(c.s, box[0], box[2]));
      expect(r.probe.held.get(s)!.size, `${c.s.name} held at the end`).toBe(0);
    }
    for (const read of r.probe.reads) {
      const c = r.cogOf(read.tiles[0]?.src ?? [...r.probe.held.keys()][0]!);
      const [c0, r0, c1, r1] = read.window as [number, number, number, number];
      expect(c1 - c0).toBeLessThanOrEqual(256); expect(r1 - r0).toBeLessThanOrEqual(256);
      expect(read.samples).toHaveLength(BAND_GROUP);
      expect(new Set(read.tiles.map((t) => t.src)).size).toBeLessThanOrEqual(1);
      expect(read.tiles.length, `${c.s.name} decoded tiles in one read`).toBeLessThanOrEqual(decodedBound(c.s));
      if (c.s.tile >= 256) expect(read.tiles.length).toBeLessThanOrEqual(BAND_GROUP * 4);
    }
    expect(r.probe.refetched).toEqual([]);
    eachByteOnce(r.files, r.log);
    await pixelsRight(r, box, 23);
  }, 120_000);
});

describe("sparse tiles (tester, GDAL SPARSE_OK)", () => {
  /** Set TileByteCounts[i] to 0 in a little-endian classic TIFF, as GDAL writes an empty tile. */
  function sparsify(bytes: Uint8Array, tiles: number[]) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true);
    for (let e = 0; e < n; e++) {
      const p = ifd + 2 + 12 * e;
      if (dv.getUint16(p, true) !== 325) continue;
      const at = dv.getUint32(p + 8, true);
      for (const i of tiles) dv.setUint32(at + 4 * i, 0, true);
    }
  }

  it("a 0-byte tile in bands 0 and 40 is never requested and reads as NaN; its neighbours are unaffected", async () => {
    const s: Spec = { name: "sp", gx0: 0, gy0: 0, width: 256, height: 256, tile: 128 }; // 4 tiles per band
    const c = await make(s);
    const bytes = c.bytes.slice();
    sparsify(bytes, [0 * 4 + 3, 40 * 4 + 3]); // south-east tile of bands 0 and 40
    const { fetch, log } = memFetch(new Map([[BASE + c.entry.path, bytes]]));
    const fetchSpy = vi.spyOn(RangeSource.prototype, "fetch");
    const aoi: Aoi = { epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: 256, height: 256 };
    const src = await fetchEntries(aoi, [c.entry], memoryStore(), { fetch, base: BASE });
    const t = await src.readWindow(0, 0, 256, 256);
    expect(t.bands[0]![200 * 256 + 200]).toBeNaN();
    expect(t.bands[40]![200 * 256 + 200]).toBeNaN();
    expect(t.bands[1]![200 * 256 + 200]).toBe(deq(pattern(1, 200, 200)));
    expect(t.bands[0]![10 * 256 + 200]).toBe(deq(pattern(0, 200, 10)));
    // geotiff.js asks the source for no slice at a sparse tile, and for each other tile exactly
    const tileOffset = (b: number, i: number) => [...c.band.entries()].filter(([, k]) => k === b).map(([o]) => o).sort((x, y) => x - y)[i]!;
    const asked = new Set(fetchSpy.mock.calls.flatMap(([sl]) => (sl as { offset: number }[]).map((x) => x.offset)));
    for (const o of [tileOffset(0, 3), tileOffset(40, 3)]) expect(asked.has(o)).toBe(false);
    for (const o of [tileOffset(0, 2), tileOffset(40, 2), tileOffset(41, 3)]) expect(asked.has(o)).toBe(true);
    eachByteOnce(new Map([[BASE + c.entry.path, bytes]]), log);
  });
});
