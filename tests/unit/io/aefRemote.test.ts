import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AefEntry, Aoi } from "../../../src/core/aef";
import { memoryStore } from "../../../src/io/aefCache";
import { fetchEntries } from "../../../src/io/aefDownload";
import { aefTiff, memFetch, pattern, type Override } from "../helpers/aefTiff";

// Criterion 12: a 206 counts only if it carries exactly the asked bytes.
const BASE = "https://aef.test/v1/annual/";
const MSG = "Couldn't download embeddings from aef.test.";
const OX = 500000, OY = 2800000;
const bytes = aefTiff({ width: 100, height: 100, x0: OX, y1: OY, tile: 64, value: (b, r, c) => pattern(b, c, r) });
const entry: AefEntry = { year: 2021, epsg: 32617, path: "2021/17N/a.tiff", x0: OX, y0: OY - 1000, x1: OX + 1000, y1: OY };
const aoi: Aoi = { epsg: 32617, gt: [OX, 10, 0, OY, 0, -10], width: 100, height: 100 };
const files = new Map([[BASE + entry.path, bytes]]);

/** Run the download with every response after the first (the header) rewritten by `bad`. */
async function withPixelResponse(bad: (range: [number, number], data: Uint8Array) => Response) {
  let n = 0;
  const override: Override = (_url, range, data) => (n++ === 0 || !range ? undefined : bad(range, data));
  const store = memoryStore();
  await expect(fetchEntries(aoi, [entry], store, { fetch: memFetch(files, override).fetch, base: BASE, blockSize: 4096 })).rejects.toThrow(MSG);
  expect(store.discarded).toBe(true);
}
const ok = (range: [number, number], data: Uint8Array) => {
  const end = Math.min(range[1], data.length - 1);
  return { body: data.slice(range[0], end + 1), end };
};
const res206 = (body: Uint8Array<ArrayBuffer>, contentRange?: string) =>
  new Response(body, { status: 206, headers: contentRange === undefined ? {} : { "Content-Range": contentRange } });

describe("206 validation (criterion 12)", () => {
  it("accepts correct 206 answers, including a last block clipped at the end of the file", async () => {
    const src = await fetchEntries(aoi, [entry], memoryStore(), { fetch: memFetch(files).fetch, base: BASE, blockSize: 4096 });
    expect((await src.readWindow(0, 0, 100, 100)).bands).toHaveLength(64);
  });

  it("refuses a 206 without Content-Range", () => withPixelResponse((r, d) => res206(ok(r, d).body)));

  it.each(["bytes */1000", "bytes 0-10", "items 0-10/1000", "garbage"])("refuses a malformed Content-Range %j", (cr) =>
    withPixelResponse((r, d) => res206(ok(r, d).body, cr)));

  it("refuses a 206 whose end differs from the asked end", () =>
    withPixelResponse((r, d) => { const { end } = ok(r, d); return res206(d.slice(r[0], end), `bytes ${r[0]}-${end - 1}/${d.length}`); }));

  it("refuses a 206 whose total differs from the file size seen before", () =>
    withPixelResponse((r, d) => { const { body, end } = ok(r, d); return res206(body, `bytes ${r[0]}-${end}/${d.length + 1}`); }));

  it("refuses a 206 whose body is longer than its Content-Range", () =>
    withPixelResponse((r, d) => { const { body, end } = ok(r, d); return res206(Uint8Array.from([...body, 0]), `bytes ${r[0]}-${end}/${d.length}`); }));

  it("refuses a header 206 that starts elsewhere than asked", async () => {
    const override: Override = (_url, range, data) => (range?.[0] === 0 ? res206(data.slice(1, 4097), `bytes 1-4096/${data.length}`) : undefined);
    const store = memoryStore();
    await expect(fetchEntries(aoi, [entry], store, { fetch: memFetch(files, override).fetch, base: BASE, blockSize: 4096 })).rejects.toThrow(MSG);
  });
});

describe("request timeout (F6)", () => {
  // Fake timers: with real ones an event-loop stall under parallel load looked like a stalled request.
  const T = 60; // ms without progress
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  /** Advance fake time in 1 ms steps until p settles, then return it. */
  async function drive<R>(p: Promise<R>): Promise<R> {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 100_000 && !done; i++) await vi.advanceTimersByTimeAsync(1);
    return p;
  }
  /** Fetch that serves the header normally and answers pixel requests with `pixel`. */
  function stalling(pixel: (range: [number, number], data: Uint8Array, signal: AbortSignal) => Promise<Response>) {
    const signals: AbortSignal[] = [];
    let n = 0;
    const { fetch: serve } = memFetch(files);
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (n++ === 0) return serve(input, init);
      const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("range") ?? "")!;
      signals.push(init.signal!);
      return pixel([Number(m[1]), Number(m[2])], bytes, init.signal!);
    }) as typeof globalThis.fetch;
    return { fetch, signals };
  }
  const run = (fetch: typeof globalThis.fetch, store = memoryStore()) => drive(fetchEntries(aoi, [entry], store, { fetch, base: BASE, blockSize: 4096, timeoutMs: T }));
  const headers = (r: [number, number], d: Uint8Array) => ({ "Content-Range": `bytes ${r[0]}-${Math.min(r[1], d.length - 1)}/${d.length}` });

  it("a request with no answer fails with the message and is aborted", async () => {
    const { fetch, signals } = stalling(() => new Promise(() => {})); // never answers, ignores abort
    const store = memoryStore();
    await expect(run(fetch, store)).rejects.toThrow(MSG);
    expect(store.discarded).toBe(true);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("after one request fails, queued requests are never sent and those in flight are aborted", async () => {
    let first = true;
    const { fetch, signals } = stalling(async () => {
      if (first) { first = false; await new Promise((ok) => setTimeout(ok, 5)); return new Response("", { status: 500 }); }
      return new Promise(() => {}); // the other in-flight requests hang
    });
    await expect(run(fetch)).rejects.toThrow(MSG);
    await vi.advanceTimersByTimeAsync(2 * T);
    expect(signals).toHaveLength(6); // a window asks for 256 tiles; only the first 6 slots were used
    expect(signals.slice(1).every((sg) => sg.aborted)).toBe(true); // the first had already ended with its 500
  });

  it("a body that stops arriving fails with the message", async () => {
    const { fetch } = stalling(async (r, d) => {
      const body = new ReadableStream({ start(c) { c.enqueue(d.slice(r[0], r[0] + 10)); } }); // never closes
      return new Response(body, { status: 206, headers: headers(r, d) });
    });
    await expect(run(fetch)).rejects.toThrow(MSG);
  });

  it("a slow body that keeps arriving is not timed out", async () => {
    const { fetch } = stalling(async (r, d) => {
      const all = d.slice(r[0], Math.min(r[1], d.length - 1) + 1), step = Math.ceil(all.length / 4);
      let i = 0;
      const body = new ReadableStream({
        async pull(c) {
          await new Promise((ok) => setTimeout(ok, T / 3)); // 4 chunks take longer than T in total
          if (i >= all.length) { c.close(); return; }
          c.enqueue(all.slice(i, i + step)); i += step;
        },
      });
      return new Response(body, { status: 206, headers: headers(r, d) });
    });
    const src = await run(fetch);
    expect((await src.readWindow(0, 0, 100, 100)).bands).toHaveLength(64);
  });

  it("keeps at most 6 requests in flight per COG, so queued ones are not timed out", async () => {
    let now = 0, peak = 0;
    const { fetch } = stalling(async (r, d) => {
      peak = Math.max(peak, ++now);
      await new Promise((ok) => setTimeout(ok, 5));
      now--;
      return new Response(d.slice(r[0], Math.min(r[1], d.length - 1) + 1), { status: 206, headers: headers(r, d) });
    });
    await run(fetch);
    expect(peak).toBe(6); // a window reads 4 tiles x 64 bands at once
  });
});
