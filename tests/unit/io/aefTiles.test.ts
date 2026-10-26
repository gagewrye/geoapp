import { describe, expect, it } from "vitest";
import type { AefEntry, Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { memoryStore } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
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
    planTiles(cog, new Map([[0, 5]])); // tile 0 of each band, last read by window 5
    const read = () => readInt8(cog, [0, 0, 10, 10]);
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
});
