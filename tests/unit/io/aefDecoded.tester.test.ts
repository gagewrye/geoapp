import { BaseDecoder } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS, type Aoi } from "../../../src/core/aef";
import { memoryStore } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { DecodedTiles } from "../../../src/io/decodedTiles";
import { BASE, colsAcross, instrument, make, OX, OY, pixelsRight, type Spec } from "../helpers/aefPassProbe";
import { memFetch } from "../helpers/aefTiff";

// Tester checks of the decoded-tile cache (spec 002 Cache: "Each COG tile is decoded once per pass
// and kept, with its bytes, until its last 256 px window"), checked structurally through decode
// counts and tiles held, never heap samples.

afterEach(() => vi.restoreAllMocks());

/** Distinct tiles of one band of a COG inside the AOI box [ax, ay, w, h] (global pixels). */
function tilesTouched(s: Spec, [ax, ay, w, h]: number[]) {
  const span = (a: number, n: number, g0: number, size: number) => {
    const lo = Math.max(a, g0) - g0, hi = Math.min(a + n, g0 + size) - g0;
    return hi <= lo ? 0 : Math.floor((hi - 1) / s.tile) - Math.floor(lo / s.tile) + 1;
  };
  return span(ax!, w!, s.gx0, s.width) * span(ay!, h!, s.gy0, s.height);
}

/**
 * Download the box, counting real decodes, the peak of decoded tiles held per COG, and any decode
 * of a tile whose fetched bytes are no longer held (the decoded cache must not outlive its bytes).
 */
async function download(specs: Spec[], [ax, ay, w, h]: [number, number, number, number]) {
  const cogs = await Promise.all(specs.map(make));
  const files = new Map(cogs.map((c) => [BASE + c.entry.path, c.bytes]));
  const fetched = instrument();
  const decodes = vi.spyOn(BaseDecoder.prototype, "decode");
  const peak = new Map<DecodedTiles, number>();
  const orphan: number[] = [];
  const get = DecodedTiles.prototype.get;
  vi.spyOn(DecodedTiles.prototype, "get").mockImplementation(function (this: DecodedTiles, offset: number, decode: () => Promise<ArrayBuffer>) {
    // get runs after geotiff.js fetched the tile, so its bytes must still be held by some COG's source
    if (![...fetched.held.values()].some((s) => s.has(offset))) orphan.push(offset);
    const p = get.call(this, offset, decode);
    peak.set(this, Math.max(peak.get(this) ?? 0, this.size));
    return p;
  });
  const aoi: Aoi = { epsg: 32617, gt: [OX + 10 * ax, 10, 0, OY - 10 * ay, 0, -10], width: w, height: h };
  const src = await fetchEntries(aoi, cogs.map((c) => c.entry), memoryStore(), { fetch: memFetch(files).fetch, base: BASE });
  const result = { decodes: decodes.mock.calls.length, peak: [...peak.values()], orphan, refetched: [...fetched.refetched] };
  vi.restoreAllMocks();
  return { ...result, src, cogs };
}

describe("decoded-tile cache, tester", () => {
  it("misaligned AOI over 512 px tiles with partial edge tiles: each tile decoded once, at most group x (C + 2) held", async () => {
    // 1100 x 1000 px COG, 512 px tiles: the edge tiles are 76 and 488 px; the AOI starts mid-tile
    const s: Spec = { name: "edge", gx0: 0, gy0: 0, width: 1100, height: 1000, tile: 512, bottomUp: true };
    const box: [number, number, number, number] = [300, 200, 790, 790];
    const r = await download([s], box);
    expect(tilesTouched(s, box)).toBe(6);
    expect(r.decodes).toBe(AEF_BANDS * 6);
    expect(r.peak).toHaveLength(1);
    expect(r.peak[0]).toBeLessThanOrEqual(BAND_GROUP * (colsAcross(s, box[0], box[2]) + 2));
    expect(r.orphan).toEqual([]);
    expect(r.refetched).toEqual([]);
    await pixelsRight({ cogs: r.cogs, src: r.src } as never, box, 31);
  });

  it("two COGs, one pixel-interleaved: one 64-band pass, each tile decoded once, nothing refetched", async () => {
    const a: Spec = { name: "sep", gx0: 0, gy0: 0, width: 400, height: 600, tile: 256, bottomUp: true };
    const b: Spec = { name: "int", gx0: 400, gy0: 0, width: 300, height: 600, tile: 256, interleaved: true };
    const box: [number, number, number, number] = [100, 50, 520, 500];
    const r = await download([a, b], box);
    expect(r.decodes).toBe(AEF_BANDS * tilesTouched(a, box) + tilesTouched(b, box));
    expect(r.orphan).toEqual([]);
    expect(r.refetched).toEqual([]);
    await pixelsRight({ cogs: r.cogs, src: r.src } as never, box, 23);
  });

  it("an AOI inside a single tile: 64 decodes for 1 x 1 windows of a 1024 px tile, peak within the bound", async () => {
    const s: Spec = { name: "one", gx0: 0, gy0: 0, width: 1024, height: 1024, tile: 1024 };
    const box: [number, number, number, number] = [700, 900, 1, 1];
    const r = await download([s], box);
    expect(r.decodes).toBe(AEF_BANDS);
    expect(r.peak[0]).toBeLessThanOrEqual(BAND_GROUP * (1 + 2));
    await pixelsRight({ cogs: r.cogs, src: r.src } as never, box, 1);
  });
});
