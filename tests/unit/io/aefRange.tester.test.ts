import { describe, expect, it } from "vitest";
import type { AefEntry, Aoi } from "../../../src/core/aef";
import { memoryStore } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
import { aefTiff, memFetch, pattern, type Override } from "../helpers/aefTiff";

// Tester tests (spec 002 criterion 12): Range answers that are not a clean 206 of the asked bytes.
const BASE = "https://aef.test/v1/annual/";
const MSG = "Couldn't download embeddings from aef.test.";
const OX = 500000, OY = 2800000;
const HEADER = 8192; // with 4 KiB blocks, requests from here on are pixel data, not the header

function cog(name: string, x0: number, width: number): { entry: AefEntry; bytes: Uint8Array } {
  const gx0 = (x0 - OX) / 10;
  // uncompressed, so wrong bytes would decode silently instead of failing inflate
  const bytes = aefTiff({ width, height: 100, x0, y1: OY, tile: 64, bottomUp: true, value: (b, r, c) => pattern(b, gx0 + c, r) });
  return { entry: { year: 2021, epsg: 32617, path: `2021/17N/${name}.tiff`, x0, y0: OY - 1000, x1: x0 + 10 * width, y1: OY }, bytes };
}
const west = cog("west", OX, 200), east = cog("east", OX + 2560, 100);
const files = new Map([[BASE + west.entry.path, west.bytes], [BASE + east.entry.path, east.bytes]]);
const aoi: Aoi = { epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: 356, height: 100 }; // west -> window 0, east -> window 1
const entries = [west.entry, east.entry];

async function attempt(override: Override) {
  const store = memoryStore();
  const run = fetchEntries(aoi, entries, store, { fetch: memFetch(files, override).fetch, base: BASE, blockSize: 4096 });
  return { run, store };
}
const eastPixels = (url: string, range: [number, number] | null) => url.endsWith("east.tiff") && range !== null && range[0] >= HEADER;

describe("Range handling (tester, criterion 12)", () => {
  it("a 200 for a pixel request after window 0 was cached shows the message and discards the partial cache", async () => {
    const { run, store } = await attempt((url, range, data) => (eastPixels(url, range) ? new Response(data.slice(), { status: 200 }) : undefined));
    await expect(run).rejects.toThrow(MSG);
    expect(store.writes).toBe(1);
    expect([store.discarded, store.windows.size]).toEqual([true, 0]);
  });

  it("a 416 for a pixel request shows the message and discards the cache", async () => {
    const { run, store } = await attempt((url, range) => (eastPixels(url, range) ? new Response("", { status: 416 }) : undefined));
    await expect(run).rejects.toThrow(MSG);
    expect(store.discarded).toBe(true);
  });

  it("a body that fails mid-stream shows the message and discards the cache", async () => {
    const { run, store } = await attempt((url, range) => {
      if (!eastPixels(url, range)) return undefined;
      const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.error(new TypeError("network error")); } });
      return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${range![0]}-${range![1]}/${east.bytes.length}` } });
    });
    await expect(run).rejects.toThrow(MSG);
    expect(store.discarded).toBe(true);
  });

  it("keeps the download error when discarding the cache also fails", async () => {
    const store = { ...memoryStore(), async discard() { throw new Error("OPFS gone"); } };
    const run = fetchEntries(aoi, entries, store, { fetch: memFetch(files, (url, range) => (eastPixels(url, range) ? "network" : undefined)).fetch, base: BASE, blockSize: 4096 });
    await expect(run).rejects.toThrow(MSG);
  });

  // Tester found RangeSource never checked Content-Range or the body length of a 206 (F2):
  // a short or shifted 206 was pasted as if it were the asked bytes.
  it("a 206 whose Content-Range starts elsewhere than asked is a download failure", async () => {
    const { run, store } = await attempt((url, range, data) => {
      if (!eastPixels(url, range)) return undefined;
      const [s, e] = [range![0] - 4096, range![1] - 4096]; // the bytes one block earlier
      return new Response(data.slice(s, e + 1), { status: 206, headers: { "Content-Range": `bytes ${s}-${e}/${data.length}` } });
    });
    await expect(run).rejects.toThrow(MSG);
    expect(store.discarded).toBe(true);
  });

  it("a short 206 body in the middle of the file is a download failure", async () => {
    const { run, store } = await attempt((url, range, data) => {
      if (!eastPixels(url, range)) return undefined;
      const end = Math.min(range![1], data.length - 1);
      return new Response(data.slice(range![0], range![0] + 100), { status: 206, headers: { "Content-Range": `bytes ${range![0]}-${end}/${data.length}` } });
    });
    await expect(run).rejects.toThrow(MSG);
    expect(store.discarded).toBe(true);
  });
});
