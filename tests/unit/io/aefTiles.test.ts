import { GeoTIFFImage } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AefEntry, Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { memoryStore } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { openRemoteCog, planTiles, readInt8, release } from "../../../src/io/aefRemote";
import { aefTiff, memFetch, pattern } from "../helpers/aefTiff";

// F3: no compressed tile is fetched twice in one download, even when one COG tile row feeds
// several window rows. Shaped like the tester's repro (uncompressed tiles taller than a window,
// AOI larger than one tile), scaled down to about 32 MB of synthetic COGs.
const BASE = "https://aef.test/v1/annual/";
const OX = 500000, OY = 2800000, T = 288;
const deq = (v: number) => Math.fround((v * Math.abs(v)) / (127.5 * 127.5));

function cog(name: string, gx0: number, width: number, height: number, bottomUp: boolean) {
  const x0 = OX + 10 * gx0;
  const bytes = aefTiff({ width, height, x0, y1: OY, tile: T, bottomUp, value: (b, r, c) => pattern(b, gx0 + c, r) });
  const entry: AefEntry = { year: 2021, epsg: 32617, path: `2021/17N/${name}.tiff`, x0, y0: OY - 10 * height, x1: x0 + 10 * width, y1: OY };
  return { entry, bytes };
}
// west: 2x2 tiles, bottom-up; east: 1x2 tiles, top-down. Tile row 1 starts at row 288, inside window row 1.
const west = cog("west", 0, 576, 576, true), east = cog("east", 576, 288, 576, false);
const files = new Map([[BASE + west.entry.path, west.bytes], [BASE + east.entry.path, east.bytes]]);
const aoi: Aoi = { epsg: 32617, gt: [OX + 200, 10, 0, OY - 200, 0, -10], width: 824, height: 536 }; // 4x3 windows

describe("each tile fetched once (F3)", () => {
  it("requests each byte at most once, covers every tile, and mosaics correctly", async () => {
    const { fetch, log } = memFetch(files);
    const src = await fetchEntries(aoi, [west.entry, east.entry], memoryStore(), { fetch, base: BASE });

    for (const w of tileWindows(aoi.width, aoi.height)) {
      const t = await src.readWindow(w.x0, w.y0, w.width, w.height);
      for (const b of [0, 33, 63]) for (let r = 0; r < w.height; r += 7) for (let c = 0; c < w.width; c += 5) {
        expect(t.bands[b]![r * w.width + c]).toBe(deq(pattern(b, 20 + w.x0 + c, 20 + w.y0 + r)));
      }
    }

    for (const [url, data] of files) {
      const ranges = log.filter((l) => l.url === url).map((l) => [l.range![0], Math.min(l.range![1], data.length - 1)] as const);
      const requested = ranges.reduce((s, [a, b]) => s + b - a + 1, 0);
      const seen = new Uint8Array(data.length);
      for (const [a, b] of ranges) seen.fill(1, a, b + 1);
      const distinct = seen.reduce((s, v) => s + v, 0);
      expect(requested, url).toBe(distinct);
      // every tile overlaps the AOI, so all bytes after the header must have been read
      const tileBytes = 64 * T * T * (url.endsWith("west.tiff") ? 4 : 2);
      expect(seen.subarray(data.length - tileBytes).every((v) => v === 1), url).toBe(true);
    }
  });

  it("keeps a planned tile until its last window is released, then drops it", async () => {
    const { fetch, log } = memFetch(files);
    const cog = await openRemoteCog(BASE + east.entry.path, fetch);
    planTiles(cog, new Map([[0, 5]]), 10, 64); // tile 0 of each band, last read by window 5 of one pass
    const read = () => readInt8(cog, [0, 0, 10, 10], [0, 64]);
    await read();
    const n = log.length;
    await read();
    release(cog, 4);
    await read();
    expect(log.length).toBe(n); // still kept
    release(cog, 5);
    await read();
    expect(log.length).toBe(n + 64); // one exact request per band tile
  });

  it("in band-group passes, band b's tile is kept until window w of pass floor(b / group)", async () => {
    const { fetch, log } = memFetch(files);
    const cog = await openRemoteCog(BASE + east.entry.path, fetch);
    planTiles(cog, new Map([[0, 5]]), 10, 8); // band 8..15 tiles are last read at step 1 x 10 + 5
    const read = () => readInt8(cog, [0, 0, 10, 10], [8, 16]);
    await read();
    const n = log.length;
    release(cog, 5); // pass 0's step 5 drops bands 0..7 only
    await read();
    expect(log.length).toBe(n);
    release(cog, 15);
    await read();
    expect(log.length).toBe(n + 8);
  });
});

describe("band-group passes (spec 002 Cache)", () => {
  afterEach(() => vi.restoreAllMocks());
  const samples = (spy: { mock: { calls: unknown[][] } }) => new Set(spy.mock.calls.map(([o]) => (o as { samples: number[] }).samples.join(",")));
  const groups = (k: number) => Array.from({ length: 64 / k }, (_, g) => Array.from({ length: k }, (_, i) => g * k + i).join(","));

  it.each([
    ["band-separate COGs are read 8 bands per pass", false, groups(BAND_GROUP)],
    ["a pixel-interleaved COG is read in one pass of 64 bands, so no tile is refetched", true, groups(64)],
  ])("%s; each byte is requested once and pixels are right", async (_n, interleaved, want) => {
    const c = cog("c", 0, 576, 576, true);
    const bytes = interleaved ? aefTiff({ width: 576, height: 576, x0: OX, y1: OY, tile: T, bottomUp: true, interleaved, value: (b, r, cc) => pattern(b, cc, r) }) : c.bytes;
    const url = BASE + c.entry.path;
    const spy = vi.spyOn(GeoTIFFImage.prototype, "readRasters");
    const { fetch, log } = memFetch(new Map([[url, bytes]]));
    const src = await fetchEntries(aoi, [c.entry], memoryStore(), { fetch, base: BASE });
    expect(samples(spy)).toEqual(new Set(want));
    const ranges = log.map((l) => [l.range![0], Math.min(l.range![1], bytes.length - 1)] as const);
    const seen = new Uint8Array(bytes.length);
    for (const [a, b] of ranges) seen.fill(1, a, b + 1);
    expect(ranges.reduce((s, [a, b]) => s + b - a + 1, 0)).toBe(seen.reduce((s, v) => s + v, 0));
    const t = await src.readWindow(256, 256, 256, 256);
    for (const b of [0, 9, 63]) for (let r = 0; r < 256; r += 11) for (let cc = 0; cc < 256; cc += 13) {
      expect(t.bands[b]![r * 256 + cc]).toBe(deq(pattern(b, 20 + 256 + cc, 20 + 256 + r)));
    }
  });
});
