import { fromArrayBuffer } from "geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AEF_BANDS, type AefEntry, type Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { opfsStore, PLANE_BYTES, type CacheStore } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { aefTiff, memFetch, pattern, type Override } from "../helpers/aefTiff";
import { FakeDir, fakeOpfs } from "../helpers/fakeOpfs";

// Tester re-verification of the per-band OPFS cache (spec 002 Cache rule, criterion 17):
// each plane written once at the right offset, edge padding -128, at most one band group of
// files open at a time, and on any failure in any pass every open writer aborted and the cache gone.
const BASE = "https://aef.test/v1/annual/";
const OX = 500000, OY = 2800000;
const MSG = "Couldn't download embeddings from aef.test.";

type Cog = { entry: AefEntry; bytes: Uint8Array; gx0: number; gy0: number; width: number; height: number };
function cog(name: string, gx0: number, gy0: number, width: number, height: number, bottomUp: boolean): Cog {
  const x0 = OX + 10 * gx0, y1 = OY - 10 * gy0;
  const bytes = aefTiff({ width, height, x0, y1, tile: 64, bottomUp, value: (b, r, c) => pattern(b, gx0 + c, gy0 + r) });
  return { entry: { year: 2021, epsg: 32617, path: `2021/17N/${name}.tiff`, x0, y0: y1 - 10 * height, x1: x0 + 10 * width, y1 }, bytes, gx0, gy0, width, height };
}
// two COGs with a 20 px gap between them (no data there); the AOI is 3 x 2 windows with clipped east and south edges
const west = cog("west", 0, 0, 300, 420, true), east = cog("east", 320, 0, 400, 420, false);
const COGS = [west, east];
const AOI_BOX = [10, 15, 600, 400] as const; // global pixel x, y, width, height
const aoi: Aoi = { epsg: 32617, gt: [OX + 10 * AOI_BOX[0], 10, 0, OY - 10 * AOI_BOX[1], 0, -10], width: AOI_BOX[2], height: AOI_BOX[3] };
const files = new Map(COGS.map((c) => [BASE + c.entry.path, c.bytes]));

/** Expected Int8 plane of band b for window i: the pattern where a COG covers it, else -128 (gap, padding). */
function want(b: number, i: number, a: Aoi = aoi, box: readonly number[] = AOI_BOX): Int8Array {
  const win = tileWindows(a.width, a.height)[i]!;
  const out = new Int8Array(PLANE_BYTES).fill(-128);
  for (let r = 0; r < win.height; r++) for (let c = 0; c < win.width; c++) {
    const gx = box[0]! + win.x0 + c, gy = box[1]! + win.y0 + r;
    if (COGS.some((k) => gx >= k.gx0 && gx < k.gx0 + k.width && gy >= k.gy0 && gy < k.gy0 + k.height)) out[r * 256 + c] = pattern(b, gx, gy);
  }
  return out;
}

/** Every writable the fake OPFS hands out, with its file name and how it ended. */
function trackWritables() {
  const ws: { file: string; state: "open" | "closed" | "aborted" }[] = [];
  let peakOpen = 0;
  const get = FakeDir.prototype.getFileHandle;
  vi.spyOn(FakeDir.prototype, "getFileHandle").mockImplementation(async function (this: FakeDir, name: string, o?: { create?: boolean }) {
    const h = await get.call(this, name, o);
    const create = h.createWritable;
    return {
      ...h,
      async createWritable() {
        const w = await create();
        const t = { file: name, state: "open" as "open" | "closed" | "aborted" };
        ws.push(t);
        peakOpen = Math.max(peakOpen, ws.filter((x) => x.state === "open").length);
        return {
          write: w.write,
          async close() { await w.close(); t.state = "closed"; },
          async abort() { await w.abort(); t.state = "aborted"; },
        };
      },
    };
  });
  return { ws, peakOpen: () => peakOpen };
}

/** Byte offsets of the tiles of band b in a COG. */
async function bandTiles(c: Cog, b: number): Promise<Set<number>> {
  const img = await (await fromArrayBuffer(c.bytes.slice().buffer)).getImage();
  const offsets = Array.from(await img.fileDirectory.loadValue("TileOffsets") as ArrayLike<number>, Number);
  const per = offsets.length / AEF_BANDS;
  return new Set(offsets.slice(b * per, (b + 1) * per));
}

afterEach(() => vi.restoreAllMocks());

describe("per-band OPFS layout (tester, criterion 17)", () => {
  it("two COGs with a gap, clipped edge windows: 64 files written once each, plane i at i x 64 KiB, padding and gap -128", async () => {
    const tw = trackWritables();
    const { handle, root, log } = fakeOpfs();
    const store = await opfsStore("aef-cache", handle);
    await fetchEntries(aoi, COGS.map((c) => c.entry), store, { fetch: memFetch(files).fetch, base: BASE });
    const n = tileWindows(aoi.width, aoi.height).length;
    expect(n).toBe(6);

    // one writable per band file, all closed, never more than one band group open at once
    expect(tw.ws.map((w) => w.file).sort()).toEqual(Array.from({ length: AEF_BANDS }, (_, b) => `b${b}.i8`).sort());
    expect(tw.ws.every((w) => w.state === "closed")).toBe(true);
    expect(tw.peakOpen()).toBe(BAND_GROUP);

    const dir = await root.getDirectoryHandle("aef-cache");
    expect(dir.entries.size).toBe(AEF_BANDS);
    for (let b = 0; b < AEF_BANDS; b++) {
      expect(log.filter((l) => l.file === `b${b}.i8`).map((l) => [l.at, l.bytes]), `b${b}`).toEqual(Array.from({ length: n }, (_, i) => [i * PLANE_BYTES, PLANE_BYTES]));
      const data = new Int8Array(await (await (await dir.getFileHandle(`b${b}.i8`)).getFile()).arrayBuffer());
      expect(data.length).toBe(n * PLANE_BYTES);
      for (let i = 0; i < n; i++) {
        const got = data.subarray(i * PLANE_BYTES, (i + 1) * PLANE_BYTES), exp = want(b, i);
        expect(got.findIndex((v, k) => v !== exp[k]), `band ${b} window ${i}`).toBe(-1);
      }
    }
    // read(i) returns the same 64 planes
    for (let i = 0; i < n; i++) {
      const planes = await store.read(i);
      expect(planes).toHaveLength(AEF_BANDS);
      for (const b of [0, 9, 63]) { const exp = want(b, i); expect(planes[b]!.findIndex((v, k) => v !== exp[k])).toBe(-1); }
    }
    await expect(store.read(n)).rejects.toThrow(`no window ${n}`);
  });

  it("a 1 x 1 px AOI is one window: 64 files of exactly 64 KiB, one valid pixel, the rest -128", async () => {
    const { handle, root } = fakeOpfs();
    const store = await opfsStore("aef-cache", handle);
    const a: Aoi = { ...aoi, gt: [OX + 10 * 100, 10, 0, OY - 10 * 50, 0, -10], width: 1, height: 1 };
    await fetchEntries(a, [west.entry], store, { fetch: memFetch(files).fetch, base: BASE });
    const dir = await root.getDirectoryHandle("aef-cache");
    for (const b of [0, 63]) {
      const data = new Int8Array(await (await (await dir.getFileHandle(`b${b}.i8`)).getFile()).arrayBuffer());
      expect(data.length).toBe(PLANE_BYTES);
      expect(data[0]).toBe(pattern(b, 100, 50));
      expect(data.subarray(1).every((v) => v === -128)).toBe(true);
    }
  });
});

describe("failure in any pass (tester, criterion 12 with the per-band cache)", () => {
  /** Run with a fake OPFS; returns the outcome, the writables, and whether the cache folder is gone. */
  async function failing(opts: { fault?: Override; wrap?: (s: CacheStore) => CacheStore }) {
    const tw = trackWritables();
    const { handle, root } = fakeOpfs();
    const raw = await opfsStore("aef-cache", handle);
    const store = opts.wrap ? opts.wrap(raw) : raw;
    const { fetch, log } = memFetch(files, opts.fault);
    const err = await fetchEntries(aoi, COGS.map((c) => c.entry), store, { fetch, base: BASE }).then(() => null, (e: unknown) => e);
    return { err, ws: tw.ws, gone: !root.entries.has("aef-cache"), log, raw };
  }
  const noneOpen = (ws: { state: string }[]) => expect(ws.filter((w) => w.state === "open")).toEqual([]);

  it.each(Array.from({ length: AEF_BANDS / BAND_GROUP }, (_, p) => p))("a network failure on the east COG's band tiles of pass %d: message, every open writer aborted, cache deleted, later passes never started", async (p) => {
    const bad = await bandTiles(east, p * BAND_GROUP + 3);
    const r = await failing({ fault: (url, range) => (url.endsWith("east.tiff") && range && bad.has(range[0]) ? "network" : undefined) });
    expect(r.err).toBeInstanceOf(Error);
    expect((r.err as Error).message).toBe(MSG);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws).toHaveLength((p + 1) * BAND_GROUP); // no writer for a later pass
    expect(r.ws.slice(p * BAND_GROUP).every((w) => w.state === "aborted")).toBe(true);
    expect(r.ws.slice(0, p * BAND_GROUP).every((w) => w.state === "closed")).toBe(true);
    await expect(r.raw.read(0)).rejects.toThrow();
  });

  it("the very last append (band 63, last window) fails: the cause surfaces, the 8 open writers are aborted, cache deleted", async () => {
    const n = tileWindows(aoi.width, aoi.height).length;
    const boom = new Error("disk full");
    const r = await failing({
      wrap: (s) => ({
        ...s,
        async band(b) {
          const w = await s.band(b);
          let i = 0;
          return { ...w, append: async (pl) => { if (b === 63 && i++ === n - 1) throw boom; return w.append(pl); } };
        },
      }),
    });
    expect(r.err).toBe(boom);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws).toHaveLength(AEF_BANDS);
    expect(r.ws.slice(56).every((w) => w.state === "aborted")).toBe(true);
  });

  it("closing band 60 in the last pass fails: bands 61..63 and band 60 are aborted, nothing left open, cache deleted", async () => {
    const boom = new Error("close failed");
    const r = await failing({
      wrap: (s) => ({
        ...s,
        async band(b) {
          const w = await s.band(b);
          return { ...w, close: async () => { if (b === 60) throw boom; return w.close(); } };
        },
      }),
    });
    expect(r.err).toBe(boom);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws.slice(60).map((w) => w.state)).toEqual(["aborted", "aborted", "aborted", "aborted"]);
  });

  it("opening band 27's file fails mid-group: bands 24..26 are aborted, the cause surfaces, cache deleted", async () => {
    const boom = new Error("quota");
    const r = await failing({ wrap: (s) => ({ ...s, band: async (b) => { if (b === 27) throw boom; return s.band(b); } }) });
    expect(r.err).toBe(boom);
    expect(r.gone).toBe(true);
    noneOpen(r.ws);
    expect(r.ws.map((w) => w.state)).toEqual([...Array(24).fill("closed"), "aborted", "aborted", "aborted"]);
  });

  it("an abort that rejects and a discard that rejects do not hide the download error", async () => {
    const r = await failing({
      fault: (url, range) => (url.endsWith("east.tiff") && range && range[0] > 20000 ? "network" : undefined),
      wrap: (s) => ({
        ...s,
        async band(b) { const w = await s.band(b); return { ...w, abort: async () => { await w.abort(); throw new Error("abort failed"); } }; },
        async discard() { throw new Error("discard failed"); },
      }),
    });
    expect((r.err as Error).message).toBe(MSG);
    noneOpen(r.ws);
  });
});
