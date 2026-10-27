import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AefEntry, Aoi } from "../../../src/core/aef";
import { tileWindows } from "../../../src/core/grid";
import { memoryStore } from "../../../src/io/aefCache";
import { BAND_GROUP, fetchEntries } from "../../../src/io/aefDownload";
import { AefDownloadError } from "../../../src/io/rangeGet";
import { RangeSource } from "../../../src/io/rangeSource";
import { aefTiff, memFetch, pattern } from "../helpers/aefTiff";

// Tester re-verification of F3 (tile lifetime, memory bound) and F6 (in-flight cap, fail-fast).
const URL_ = "https://aef.test/v1/annual/2021/17N/a.tiff";
const MSG = "Couldn't download embeddings from aef.test.";
const SIZE = 1 << 20;
const TILE = 1000; // bytes per fake tile
const offsetOf = (i: number) => 200_000 + i * TILE;

type Pending = { start: number; end: number; signal: AbortSignal; answer: (status?: number) => void; settled: boolean };

/** Fetch whose answers the test releases by hand; aborting rejects like a browser fetch does. */
function manualFetch(opts: { ignoreAbort?: boolean } = {}) {
  const pending: Pending[] = [];
  let inFlight = 0, peak = 0;
  const fetch = ((_u: string, init: RequestInit) => new Promise<Response>((ok, no) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range") ?? "")!;
    const start = Number(m[1]), end = Number(m[2]);
    inFlight++; peak = Math.max(peak, inFlight);
    const p: Pending = {
      start, end, signal: init.signal!, settled: false,
      answer: (status = 206) => {
        if (p.settled) return;
        p.settled = true; inFlight--;
        ok(status === 206
          ? new Response(new Uint8Array(end - start + 1), { status, headers: { "Content-Range": `bytes ${start}-${end}/${SIZE}` } })
          : new Response("err", { status }));
      },
    };
    if (!opts.ignoreAbort) init.signal!.addEventListener("abort", () => { if (!p.settled) { p.settled = true; inFlight--; no(init.signal!.reason); } });
    pending.push(p);
  })) as unknown as typeof globalThis.fetch;
  return { fetch, pending, peak: () => peak, inFlight: () => inFlight };
}

/** A RangeSource with n planned tiles at offsetOf(i), as openRemoteCog + planTiles leave it. */
function source(fetch: typeof globalThis.fetch, n: number, timeoutMs?: number) {
  const s = new RangeSource(URL_, fetch, 65536, timeoutMs);
  for (let i = 0; i < n; i++) s.plan(offsetOf(i), TILE);
  return s;
}
const slices = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ offset: offsetOf(from + i), length: TILE }));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/**
 * Planned tiles each RangeSource holds, seen through its public plan, fetch and release: a planned
 * tile is kept from its first fetch until its release (the plan contract, checked in "tile lifetime").
 */
function trackHeld() {
  const planned = new Map<RangeSource, Map<number, number>>(), held = new Map<RangeSource, Set<number>>(), peak = new Map<RangeSource, number>();
  const { plan, fetch, release } = RangeSource.prototype;
  vi.spyOn(RangeSource.prototype, "plan").mockImplementation(function (this: RangeSource, offset: number, length: number) {
    if (!planned.has(this)) { planned.set(this, new Map()); held.set(this, new Set()); }
    planned.get(this)!.set(offset, length);
    plan.call(this, offset, length);
  });
  vi.spyOn(RangeSource.prototype, "fetch").mockImplementation(function (this: RangeSource, sl: { offset: number; length: number }[], signal?: AbortSignal) {
    const h = held.get(this);
    if (h) {
      for (const x of sl) if (planned.get(this)!.get(x.offset) === x.length) h.add(x.offset);
      peak.set(this, Math.max(peak.get(this) ?? 0, h.size));
    }
    return fetch.call(this, sl, signal);
  });
  vi.spyOn(RangeSource.prototype, "release").mockImplementation(function (this: RangeSource, offset: number) {
    held.get(this)?.delete(offset);
    release.call(this, offset);
  });
  return { held, peak };
}

let unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };
beforeEach(() => { unhandled = []; process.on("unhandledRejection", onUnhandled); });
afterEach(() => { process.off("unhandledRejection", onUnhandled); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("in-flight cap (tester, F6)", () => {
  it("20 tiles asked at once: never more than 6 requests in flight, every tile arrives, slots all returned", async () => {
    const f = manualFetch();
    const s = source(f.fetch, 26);
    const all = s.fetch(slices(0, 20));
    for (let round = 0; round < 50 && !(f.pending.length === 20 && f.pending.every((p) => p.settled)); round++) {
      await new Promise((ok) => setTimeout(ok, 1));
      expect(f.inFlight()).toBeLessThanOrEqual(6);
      f.pending.filter((p) => !p.settled).forEach((p) => p.answer());
    }
    const bufs = await all;
    expect(bufs.map((b) => b.byteLength)).toEqual(Array(20).fill(TILE));
    expect(f.peak()).toBe(6);
    expect(f.pending).toHaveLength(20); // each tile exactly once
    // slots all returned: 6 more tiles go out at once
    const more = s.fetch(slices(20, 26));
    await flush();
    expect(f.pending).toHaveLength(26);
    f.pending.slice(20).forEach((p) => p.answer());
    await more;
  });

  it("time spent queued for a slot does not count toward the 30 s timeout (fake timers)", async () => {
    vi.useFakeTimers();
    const f = manualFetch();
    const s = source(f.fetch, 7); // default timeout
    let result: ArrayBuffer[] | undefined, error: unknown;
    s.fetch(slices(0, 7)).then((r) => { result = r; }, (e) => { error = e; });
    // each request is answered 25 s after it is sent; the 7th is sent at 25 s and answered at 50 s
    for (let t = 0; t < 4; t++) {
      await vi.advanceTimersByTimeAsync(25_000);
      f.pending.filter((p) => !p.settled).forEach((p) => p.answer());
      await flush();
    }
    expect(error).toBeUndefined();
    expect(result).toHaveLength(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("tile lifetime (tester, F3)", () => {
  it("a planned tile is fetched once until released; after release, reading it again makes one more request", async () => {
    const f = manualFetch();
    const s = source(f.fetch, 1);
    const read = async () => { const p = s.fetch(slices(0, 1)); await flush(); f.pending.forEach((x) => x.answer()); return p; };
    await read();
    await read();
    expect(f.pending).toHaveLength(1);
    s.release(offsetOf(0));
    await read();
    expect(f.pending).toHaveLength(2);
  });
});

describe("fail-fast (tester, F6)", () => {
  it("first failure: rejects with the message, aborts the 5 others in flight, never sends the 4 queued, no unhandled rejection", async () => {
    const f = manualFetch();
    const s = source(f.fetch, 10);
    const all = s.fetch(slices(0, 10));
    await flush();
    expect(f.pending).toHaveLength(6);
    f.pending[2]!.answer(500);
    await expect(all).rejects.toThrow(MSG);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(f.pending).toHaveLength(6);
    expect(f.pending.filter((p, i) => i !== 2).every((p) => p.signal.aborted && p.settled)).toBe(true);
    // nothing queued or kept: asking for the same tiles again rejects without a request
    await expect(s.fetch(slices(0, 10))).rejects.toThrow(MSG);
    expect(f.pending).toHaveLength(6);
    expect(unhandled).toEqual([]);
  });

  it("with a fetch that ignores abort, the rejection still arrives and nothing dangles", async () => {
    const f = manualFetch({ ignoreAbort: true });
    const s = source(f.fetch, 10);
    const all = s.fetch(slices(0, 10));
    await flush();
    f.pending[0]!.answer(404);
    await expect(all).rejects.toBeInstanceOf(AefDownloadError);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(f.pending).toHaveLength(6);
    expect(f.pending.slice(1).every((p) => p.signal.aborted)).toBe(true);
    await expect(s.fetch(slices(0, 10))).rejects.toBeInstanceOf(AefDownloadError);
    expect(f.pending).toHaveLength(6);
    expect(unhandled).toEqual([]);
  });

  it("after a failure, later reads from the same COG fail without a request", async () => {
    const f = manualFetch();
    const s = source(f.fetch, 3);
    const first = s.fetch(slices(0, 1));
    await flush();
    f.pending[0]!.answer(503);
    await expect(first).rejects.toThrow(MSG);
    await expect(s.fetch(slices(1, 3))).rejects.toThrow(MSG);
    await expect(s.fetch([{ offset: 0, length: 100 }])).rejects.toThrow(MSG); // header path too
    expect(f.pending).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it("a header block shared by concurrent reads fails once, for both, without unhandled rejections", async () => {
    const f = manualFetch();
    const s = new RangeSource(URL_, f.fetch, 4096);
    const a = s.fetch([{ offset: 0, length: 100 }]), b = s.fetch([{ offset: 50, length: 3000 }]);
    await flush();
    expect(f.pending).toHaveLength(1);
    f.pending[0]!.answer(500);
    await expect(a).rejects.toThrow(MSG);
    await expect(b).rejects.toThrow(MSG);
    await new Promise((ok) => setTimeout(ok, 10));
    expect(unhandled).toEqual([]);
  });

  it("a whole download failing mid-way: rejects, discards, sends nothing more afterwards, no unhandled rejection", async () => {
    const BASE = "https://aef.test/v1/annual/", OX = 500000, OY = 2800000;
    const bytes = aefTiff({ width: 300, height: 300, x0: OX, y1: OY, tile: 64, value: (b, r, c) => pattern(b, c, r) });
    const entry: AefEntry = { year: 2021, epsg: 32617, path: "2021/17N/a.tiff", x0: OX, y0: OY - 3000, x1: OX + 3000, y1: OY };
    let n = 0;
    const { fetch, log } = memFetch(new Map([[BASE + entry.path, bytes]]), () => (++n === 40 ? new Response("x", { status: 500 }) : undefined));
    const store = memoryStore();
    const aoi: Aoi = { epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: 300, height: 300 };
    await expect(fetchEntries(aoi, [entry], store, { fetch, base: BASE })).rejects.toThrow(MSG);
    const sent = log.length;
    await new Promise((ok) => setTimeout(ok, 50));
    expect(log.length).toBe(sent);
    expect(sent).toBeLessThanOrEqual(40 + 5); // at most the 5 others in flight when it failed
    expect(store.discarded).toBe(true);
    expect(unhandled).toEqual([]);
  });
});

describe("tile lifetime and memory bound through fetchEntries (tester, F3, structural)", () => {
  const BASE = "https://aef.test/v1/annual/", OX = 500000, OY = 2800000;
  type Cog = { name: string; gx0: number; gy0: number; width: number; height: number; tile: number; bottomUp: boolean };
  /** COG at global pixel (gx0, gy0) from (OX, OY), deflated so large layouts stay small. */
  function make(c: Cog) {
    const x0 = OX + 10 * c.gx0, y1 = OY - 10 * c.gy0;
    const bytes = aefTiff({ width: c.width, height: c.height, x0, y1, tile: c.tile, bottomUp: c.bottomUp, deflate: true, value: (b, r, cc) => pattern(b, c.gx0 + cc, c.gy0 + r) });
    const entry: AefEntry = { year: 2021, epsg: 32617, path: `2021/17N/${c.name}.tiff`, x0, y0: y1 - 10 * c.height, x1: x0 + 10 * c.width, y1 };
    return { c, bytes, entry };
  }
  /** Distinct tile columns of a COG overlapping an AOI at global pixel (ax, ay) of size w x h. */
  function colsAcross(c: Cog, ax: number, w: number) {
    const a = Math.max(ax, c.gx0) - c.gx0, b = Math.min(ax + w, c.gx0 + c.width) - c.gx0;
    return b <= a ? 0 : Math.floor((b - 1) / c.tile) - Math.floor(a / c.tile) + 1;
  }
  const deq = (v: number) => Math.fround((v * Math.abs(v)) / (127.5 * 127.5));

  const layouts: [string, Cog[], [number, number, number, number]][] = [
    ["256 px tiles aligned to the AOI, top-down", [{ name: "a", gx0: 0, gy0: 0, width: 768, height: 512, tile: 256, bottomUp: false }], [0, 0, 768, 512]],
    ["288 px tiles straddling window rows, bottom-up, COG starts before the AOI", [{ name: "a", gx0: -40, gy0: -70, width: 864, height: 864, tile: 288, bottomUp: true }], [0, 0, 700, 650]],
    ["320 px tiles, two COGs of mixed orientation side by side, AOI at an odd offset",
      [{ name: "w", gx0: 0, gy0: 0, width: 640, height: 960, tile: 320, bottomUp: true }, { name: "e", gx0: 640, gy0: 0, width: 640, height: 960, tile: 320, bottomUp: false }],
      [133, 77, 1000, 800]],
    ["512 px tiles, AOI past the COG's south-east corner", [{ name: "a", gx0: 0, gy0: 0, width: 1024, height: 1024, tile: 512, bottomUp: true }], [300, 500, 900, 800]],
    // tester follow-up T3: below 256 px a window row spans several tile rows and columns
    ["64 px tiles, bottom-up, COG starts before the AOI", [{ name: "a", gx0: -10, gy0: -30, width: 700, height: 600, tile: 64, bottomUp: true }], [0, 0, 600, 520]],
    ["100 px tiles, which do not divide 256", [{ name: "a", gx0: 0, gy0: 0, width: 800, height: 700, tile: 100, bottomUp: false }], [37, 51, 700, 600]],
  ];
  /** Tiles held per COG (spec 002 Cache, aefDownload): group x (C + ceil(256 / th) x (ceil(256 / tw) + 1)). */
  const bound = (c: Cog, ax: number, w: number) => BAND_GROUP * (colsAcross(c, ax, w) + Math.ceil(256 / c.tile) * (Math.ceil(256 / c.tile) + 1));

  it.each(layouts)("%s: peak tiles held within the bound, all released at the end, each byte fetched once, pixels right", async (_n, specs, [ax, ay, w, h]) => {
    const cogs = specs.map(make);
    const files = new Map(cogs.map((k) => [BASE + k.entry.path, k.bytes]));
    const { held, peak } = trackHeld();
    const { fetch, log } = memFetch(files);
    const aoi: Aoi = { epsg: 32617, gt: [OX + 10 * ax, 10, 0, OY - 10 * ay, 0, -10], width: w, height: h };
    const src = await fetchEntries(aoi, cogs.map((k) => k.entry).reverse(), memoryStore(), { fetch, base: BASE });
    vi.restoreAllMocks();
    expect(held.size).toBe(cogs.length);
    expect(new Set(cogs.map((k) => k.bytes.length)).size).toBe(cogs.length); // so fileSize tells the COGs apart
    for (const [s, tiles] of held) {
      const { c, entry } = cogs.find((k) => k.bytes.length === s.fileSize)!;
      expect(peak.get(s), entry.path).toBeLessThanOrEqual(bound(c, ax, w));
      if (c.tile >= 256) expect(bound(c, ax, w)).toBe(BAND_GROUP * (colsAcross(c, ax, w) + 2));
      expect(tiles.size, `${entry.path} tiles left after the download`).toBe(0);
    }
    for (const [url, data] of files) {
      const ranges = log.filter((l) => l.url === url).map((l) => [l.range![0], Math.min(l.range![1], data.length - 1)] as const);
      const seen = new Uint8Array(data.length);
      for (const [a, b] of ranges) seen.fill(1, a, b + 1);
      expect(ranges.reduce((t, [a, b]) => t + b - a + 1, 0), url).toBe(seen.reduce((t, v) => t + v, 0));
    }
    for (const win of tileWindows(w, h)) {
      const t = await src.readWindow(win.x0, win.y0, win.width, win.height);
      for (const b of [0, 63]) for (let r = 0; r < win.height; r += 37) for (let c = 0; c < win.width; c += 41) {
        const gx = ax + win.x0 + c, gy = ay + win.y0 + r;
        const inside = cogs.some(({ c: k }) => gx >= k.gx0 && gx < k.gx0 + k.width && gy >= k.gy0 && gy < k.gy0 + k.height);
        const v = t.bands[b]![r * win.width + c]!;
        if (inside) expect(v).toBe(deq(pattern(b, gx, gy))); else expect(v).toBeNaN();
      }
    }
  }, 60_000);
});
