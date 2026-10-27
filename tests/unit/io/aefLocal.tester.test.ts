import { fromArrayBuffer } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dequantize, type AefEntry, type Aoi } from "../../../src/core/aef";
import { memoryStore } from "../../../src/io/aefCache";
import { downloadAoi } from "../../../src/io/aefDownload";
import { openGeoTiff } from "../../../src/io/geotiffSource";
import { aefTiff, pattern } from "../helpers/aefTiff";
import { firstDiff } from "../helpers/floats";

afterEach(() => vi.unstubAllGlobals());

describe("local AEF COG partial windows (tester, criterion 15)", () => {
  it.each([true, false])("bottomUp=%s: an edge window equals dequantize of the same file pixels, with no network", async (bottomUp) => {
    const fetch = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetch);
    const W = 100, H = 70;
    const bytes = aefTiff({ width: W, height: H, x0: 500000, y1: 2800000, tile: 32, bottomUp, value: (b, r, c) => (r === 69 && c === 99 ? -128 : pattern(b, c, r)) });
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const src = await openGeoTiff(await fromArrayBuffer(buf));
    expect(src.meta.nodata).toBeNull();
    const t = await src.readWindow(90, 60, 10, 10); // last partial tile in both axes
    const raw = (await (await fromArrayBuffer(buf)).getImage()).readRasters({ window: [90, 60, 100, 70] }) as unknown as Promise<Int8Array[]>;
    const q = await raw;
    for (let k = 0; k < 64; k++) {
      const want = new Float32Array(100);
      dequantize(q[k]!, want);
      expect(firstDiff(t.bands[k]!, want), `band ${k}`).toBe(-1);
    }
    // the -128 pixel at north-up (69, 99) sits at file row 0 when bottom-up, else at the window's last pixel
    expect(t.bands[0]!.filter(Number.isNaN).length).toBe(bottomUp ? 0 : 1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("no entries edges (tester, criterion 13)", () => {
  const aoi: Aoi = { epsg: 32617, gt: [500000, 10, 0, 2800000, 0, -10], width: 100, height: 100 }; // x 500000..501000, y 2799000..2800000
  const e = (o: Partial<AefEntry>): AefEntry => ({ year: 2021, epsg: 32617, path: "2021/17N/x.tiff", x0: 501000, y0: 2799000, x1: 502000, y1: 2800000, ...o });
  function fakeFetch(shard: unknown) {
    const urls: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(shard), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;
    return { fetch, urls };
  }

  it.each([
    ["only an edge-touching entry", [e({})]],
    ["only another year's entry (mislabelled shard)", [e({ year: 2020, x0: 500000, x1: 501000 })]],
    ["only another zone's entry", [e({ epsg: 32618, x0: 500000, x1: 501000 })]],
    ["an empty shard", []],
  ])("%s: shows the message and requests only the shard", async (_n, shard) => {
    const { fetch, urls } = fakeFetch(shard);
    const store = memoryStore();
    await expect(downloadAoi(aoi, 2021, store, { fetch, appBase: "/app/" })).rejects.toThrow("No AlphaEarth embeddings here for 2021.");
    expect(urls).toEqual(["/app/aef-index/2021/32617.json"]);
    expect(store.writes).toBe(0);
  });
});
