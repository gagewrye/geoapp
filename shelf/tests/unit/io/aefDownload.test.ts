import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AEF_BASE, dequantize, type AefEntry, type Aoi } from "../../../src/core/aef";
import { BAND_GROUP, downloadAoi, fetchEntries } from "../../../src/io/aefDownload";
import { memoryStore, PLANE_BYTES } from "../../../src/io/aefCache";
import { loadYears } from "../../../src/io/aefIndex";
import { firstDiff } from "../helpers/floats";
import { rangeFetch } from "../helpers/rangeFetch";

const F = "tests/fixtures/aef";
const json = <T>(p: string): T => JSON.parse(readFileSync(`${F}/${p}`, "utf8")) as T;
const chip = json<{ epsg: number; x0: number; y1: number; width: number; height: number; invalid: number }>("ref_chip.json");
const entries = json<AefEntry[]>("aef-index/2021/32617.json");
const shifted = json<AefEntry>("shifted-entry.json");
const refBuf = readFileSync(`${F}/ref_chip.i8`);
const ref = new Int8Array(refBuf.buffer, refBuf.byteOffset, refBuf.length); // [64][128][128] north-up
const N = chip.width;
const HOST = new URL(AEF_BASE).host;

const chipAoi: Aoi = { epsg: chip.epsg, gt: [chip.x0, 10, 0, chip.y1, 0, -10], width: N, height: N };
/** Chip at AOI cols 192..319: the west COG lands in window 0, the east COGs in window 1. */
const wideAoi: Aoi = { epsg: chip.epsg, gt: [chip.x0 - 1920, 10, 0, chip.y1 + 1000, 0, -10], width: 320, height: 228 };

function refBand(k: number): Float32Array {
  const out = new Float32Array(N * N);
  dequantize(ref.subarray(k * N * N, (k + 1) * N * N), out);
  return out;
}

describe("mosaic of mixed-orientation COGs (criterion 7)", () => {
  it("an AOI equal to the chip dequantizes exactly to the reference chip, invalid pixels NaN", async () => {
    const { fetch } = rangeFetch();
    const store = memoryStore();
    const src = await fetchEntries(chipAoi, entries, store, { fetch });
    expect(src.meta).toMatchObject({ width: N, height: N, bandCount: 64, epsg: 32617, gt: chipAoi.gt, nodata: null });
    const tile = await src.readWindow(0, 0, N, N);
    for (let k = 0; k < 64; k++) expect(firstDiff(tile.bands[k]!, refBand(k)), `band ${k}`).toBe(-1);
    expect(tile.bands[0]!.filter(Number.isNaN).length).toBe(chip.invalid);
    expect(chip.invalid).toBeGreaterThan(0);
    expect([...store.files.values()].map((planes) => planes.map((p) => p.length))).toEqual(Array(64).fill([PLANE_BYTES]));
  });

  it("pixels covered by no COG are NaN, and windows split the chip correctly", async () => {
    const { fetch } = rangeFetch();
    const src = await fetchEntries(wideAoi, entries, memoryStore(), { fetch });
    const w0 = await src.readWindow(0, 0, 256, 228);
    const w1 = await src.readWindow(256, 0, 64, 228);
    for (let k = 0; k < 64; k++) {
      const want = refBand(k);
      const got = new Float32Array(320 * 228), exp = new Float32Array(320 * 228).fill(NaN);
      for (let r = 0; r < 228; r++) for (let c = 0; c < 320; c++) {
        got[r * 320 + c] = c < 256 ? w0.bands[k]![r * 256 + c]! : w1.bands[k]![r * 64 + c - 256]!;
        if (c >= 192 && r >= 100) exp[r * 320 + c] = want[(r - 100) * N + c - 192]!;
      }
      expect(firstDiff(got, exp), `band ${k}`).toBe(-1);
    }
  });

  it("refuses a COG 5 m off the grid, before caching anything", async () => {
    const { fetch } = rangeFetch();
    const store = memoryStore();
    await expect(fetchEntries(chipAoi, [...entries, shifted], store, { fetch })).rejects.toThrow(`AlphaEarth file ${shifted.path} is not on the area's 10 m grid.`);
    expect(store.writes).toBe(0);
    expect(store.discarded).toBe(true);
  });

  it("reads only aligned cache windows", async () => {
    const src = await fetchEntries(chipAoi, entries, memoryStore(), { fetch: rangeFetch().fetch });
    await expect(src.readWindow(10, 0, 20, 20)).rejects.toThrow(/window/);
  });
});

describe("download failures (criterion 12)", () => {
  const message = `Couldn't download embeddings from ${HOST}.`;
  const isCog = (url: string) => url.startsWith(AEF_BASE);
  it.each([
    ["a 200 full-file response", (url: string) => (isCog(url) ? 200 : undefined)],
    ["a 404", (url: string) => (isCog(url) ? 404 : undefined)],
    ["a 500", (url: string) => (isCog(url) ? 500 : undefined)],
    ["a network error or CORS failure", (url: string) => (isCog(url) ? "network" as const : undefined)],
  ])("%s shows the download message and discards the cache", async (_name, fault) => {
    const store = memoryStore();
    const { fetch } = rangeFetch(fault);
    await expect(downloadAoi(chipAoi, 2021, store, { fetch })).rejects.toThrow(message);
    expect(store.discarded).toBe(true);
    expect(store.files.size).toBe(0);
  });

  it("a failure after some windows were cached discards the partial cache", async () => {
    // small blocks so the east COG's pixels are fetched only when window 1 is filled
    const fault = (url: string, range: [number, number] | null) => (url.endsWith("fixture-ne-topdown.tiff") && range && range[0] >= 8192 ? "network" as const : undefined);
    const store = memoryStore();
    await expect(fetchEntries(wideAoi, entries, store, { fetch: rangeFetch(fault).fetch, blockSize: 4096 })).rejects.toThrow(message);
    expect(store.writes).toBe(BAND_GROUP); // window 0 of the first band pass
    expect(store.discarded).toBe(true);
    expect(store.files.size).toBe(0);
  });
});

describe("no entries (criterion 13)", () => {
  const elsewhere: Aoi = { epsg: 32617, gt: [600000, 10, 0, 3000000, 0, -10], width: 100, height: 100 };
  it("an AOI with no entries shows the message and makes no COG requests", async () => {
    const { fetch, log } = rangeFetch();
    const store = memoryStore();
    await expect(downloadAoi(elsewhere, 2021, store, { fetch })).rejects.toThrow("No AlphaEarth embeddings here for 2021.");
    expect(log.map((l) => l.url)).toEqual(["/aef-index/2021/32617.json"]);
    expect(store.writes).toBe(0);
  });

  it("a missing shard (404) means no entries", async () => {
    const { fetch, log } = rangeFetch();
    await expect(downloadAoi(chipAoi, 2019, memoryStore(), { fetch })).rejects.toThrow("No AlphaEarth embeddings here for 2019.");
    expect(log.map((l) => l.url)).toEqual(["/aef-index/2019/32617.json"]);
  });

  it("an HTML fallback page for a missing shard means no entries", async () => {
    // dev and preview servers answer unknown paths with index.html and 200
    const fetch = (async () => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } })) as typeof globalThis.fetch;
    await expect(downloadAoi(chipAoi, 2021, memoryStore(), { fetch })).rejects.toThrow("No AlphaEarth embeddings here for 2021.");
  });

  it("any other index failure is reported, not taken as empty", async () => {
    const { fetch } = rangeFetch((url) => (url.startsWith("/aef-index/") ? 500 : undefined));
    await expect(downloadAoi(chipAoi, 2021, memoryStore(), { fetch })).rejects.toThrow("Couldn't load the AlphaEarth index (HTTP 500).");
  });
});

describe("requests (criterion 9)", () => {
  it("from the app origin only years.json and the {year}/{epsg} shard; COGs only as ranged GETs to AEF_BASE", async () => {
    const { fetch, log } = rangeFetch();
    expect(await loadYears(fetch)).toEqual([2021]);
    await downloadAoi(chipAoi, 2021, memoryStore(), { fetch });
    const app = log.filter((l) => !l.url.startsWith(AEF_BASE)).map((l) => l.url);
    expect(app).toEqual(["/aef-index/years.json", "/aef-index/2021/32617.json"]);
    const cogs = log.filter((l) => l.url.startsWith(AEF_BASE));
    expect(new Set(cogs.map((l) => l.url.slice(AEF_BASE.length)))).toEqual(new Set(entries.map((e) => e.path)));
    for (const l of log) expect(l.method).toBe("GET");
    for (const l of cogs) {
      expect(Object.keys(l.headers)).toEqual(["range"]);
      expect(l.credentials).toBe("omit");
      expect(l.body).toBeUndefined();
    }
  });
});

describe("request pattern", () => {
  const key = (l: { url: string; headers: Record<string, string> }) => `${l.url} ${l.headers.range ?? ""}`;
  it("depends only on the AOI and year: two downloads send identical requests", async () => {
    const a = rangeFetch(), b = rangeFetch();
    await downloadAoi(wideAoi, 2021, memoryStore(), { fetch: a.fetch, blockSize: 4096 });
    await downloadAoi(wideAoi, 2021, memoryStore(), { fetch: b.fetch, blockSize: 4096 });
    expect(a.log.map(key)).toEqual(b.log.map(key));
    expect(a.log.length).toBeGreaterThan(3);
  });

  it("fetches each byte range once while it stays cached", async () => {
    const { fetch, log } = rangeFetch();
    await fetchEntries(wideAoi, entries, memoryStore(), { fetch, blockSize: 4096 });
    const keys = log.map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
