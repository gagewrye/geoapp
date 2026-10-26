import { BaseDecoder } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { memoryStore } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { DecodedTiles } from "../../../src/io/decodedTiles";
import { aefTiff, memFetch, pattern } from "../helpers/aefTiff";

// Each 512 px tile spans 3 x 3 of the AOI's 256 px windows, so without a decoded-tile cache
// geotiff.js would decode it once per window.
const BASE = "https://aef.test/v1/annual/";
const OX = 500000, OY = 2800000, T = 512;
const deq = (v: number) => Math.fround((v * Math.abs(v)) / (127.5 * 127.5));

function cog(name: string, gx0: number, o: { interleaved?: boolean; bottomUp?: boolean } = {}) {
  const x0 = OX + 10 * gx0, W = 1024, H = 1024;
  const bytes = aefTiff({ width: W, height: H, x0, y1: OY, tile: T, deflate: true, ...o, value: (b, r, c) => pattern(b, gx0 + c, r) });
  const entry: AefEntry = { year: 2021, epsg: 32617, path: `2021/17N/${name}.tiff`, x0, y0: OY - 10 * H, x1: x0 + 10 * W, y1: OY };
  return { entry, files: new Map([[BASE + entry.path, bytes]]) };
}
// AOI columns and rows 200..800: 3 x 3 windows over 2 x 2 tiles of each band
const aoi: Aoi = { epsg: 32617, gt: [OX + 2000, 10, 0, OY - 2000, 0, -10], width: 600, height: 600 };

/** Counts real decodes, and the decoded tiles held by any DecodedTiles (peak and at the end). */
function probe() {
  const decodes = vi.spyOn(BaseDecoder.prototype, "decode");
  const caches = new Set<DecodedTiles>();
  let peak = 0;
  const get = DecodedTiles.prototype.get;
  vi.spyOn(DecodedTiles.prototype, "get").mockImplementation(function (this: DecodedTiles, ...a: Parameters<typeof get>) {
    caches.add(this);
    const p = get.apply(this, a);
    peak = Math.max(peak, this.size);
    return p;
  });
  return { decodes, peak: () => peak, heldAtEnd: () => [...caches].reduce((s, c) => s + c.size, 0) };
}

afterEach(() => vi.restoreAllMocks());

describe("decoded-tile cache (spec 002 Cache follow-up)", () => {
  it("band-separate: each tile is decoded once per download, at most group x (C + 2) held, none at the end", async () => {
    const c = cog("sep", 0, { bottomUp: true });
    const p = probe();
    const src = await fetchEntries(aoi, [c.entry], memoryStore(), { fetch: memFetch(c.files).fetch, base: BASE });
    expect(p.decodes).toHaveBeenCalledTimes(AEF_BANDS * 4);
    expect(p.peak()).toBeLessThanOrEqual(BAND_GROUP * (2 + 2));
    expect(p.heldAtEnd()).toBe(0);
    for (const w of tileWindows(aoi.width, aoi.height)) {
      const t = await src.readWindow(w.x0, w.y0, w.width, w.height);
      for (const b of [0, 9, 63]) for (let r = 0; r < w.height; r += 37) for (let k = 0; k < w.width; k += 41) {
        expect(t.bands[b]![r * w.width + k]).toBe(deq(pattern(b, 200 + w.x0 + k, 200 + w.y0 + r)));
      }
    }
  });

  it("pixel-interleaved: each 64-band tile is decoded once, in the single pass", async () => {
    const c = cog("int", 0, { interleaved: true });
    const p = probe();
    const src = await fetchEntries(aoi, [c.entry], memoryStore(), { fetch: memFetch(c.files).fetch, base: BASE });
    expect(p.decodes).toHaveBeenCalledTimes(4);
    expect(p.heldAtEnd()).toBe(0);
    const t = await src.readWindow(256, 256, 256, 256);
    expect(t.bands[40]![100 * 256 + 100]).toBe(deq(pattern(40, 200 + 356, 200 + 356)));
  });
});
