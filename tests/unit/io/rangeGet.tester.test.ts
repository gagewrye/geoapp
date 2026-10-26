import { afterEach, describe, expect, it, vi } from "vitest";
import { AefDownloadError, getRange, IDLE_TIMEOUT_MS, type RangeGet } from "../../../src/io/rangeGet";

// Tester re-verification of F2 (Content-Range validation) and F6 (30 s no-progress timeout).
const URL_ = "https://aef.test/v1/annual/2021/17N/a.tiff";
const MSG = "Couldn't download embeddings from aef.test.";
const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);

const req = (start: number, end: number, fetchFn: typeof fetch, size: number | null = null, extra: Partial<RangeGet> = {}): RangeGet =>
  ({ url: URL_, fetchFn, start, end, size, timeoutMs: IDLE_TIMEOUT_MS, ...extra });
const answer = (status: number, body: Uint8Array<ArrayBuffer> | null, contentRange?: string) =>
  (async () => new Response(body, { status, headers: contentRange === undefined ? {} : { "Content-Range": contentRange } })) as unknown as typeof fetch;

describe("Content-Range validation (tester, F2 / criterion 12)", () => {
  it("accepts an exact 206 and returns the bytes and file size", async () => {
    const r = await getRange(req(10, 19, answer(206, FILE.slice(10, 20), "bytes 10-19/1000")));
    expect(new Uint8Array(r.body)).toEqual(FILE.slice(10, 20));
    expect(r.total).toBe(1000);
  });

  it("accepts a range past the end of a small file, clipped at its last byte", async () => {
    const r = await getRange(req(0, 65535, answer(206, FILE.slice(), "bytes 0-999/1000")));
    expect(r.body.byteLength).toBe(1000);
  });

  it("a server ignoring Range for a small file (200 with the whole file) is a download failure", async () => {
    await expect(getRange(req(0, 65535, answer(200, FILE.slice())))).rejects.toThrow(MSG);
  });

  it("a server ignoring Range but sending 206 with the whole file for a sub-range is a download failure", async () => {
    await expect(getRange(req(100, 199, answer(206, FILE.slice(), "bytes 0-999/1000")))).rejects.toThrow(MSG);
  });

  it.each([
    ["a suffix-style answer (last 100 bytes) for bytes=0-99", 0, 99, "bytes 900-999/1000", FILE.slice(900)],
    ["unknown total", 0, 99, "bytes 0-99/*", FILE.slice(0, 100)],
    ["a clip short of the end of the file", 0, 199, "bytes 0-99/1000", FILE.slice(0, 100)],
    ["end before start", 50, 99, "bytes 50-10/1000", FILE.slice(50, 100)],
    ["start at or past the file size", 1000, 1099, "bytes 1000-999/1000", new Uint8Array(0)],
    ["end past the total", 0, 99, "bytes 0-99/50", FILE.slice(0, 100)],
    ["a multipart byteranges answer", 0, 99, undefined, FILE.slice(0, 100)],
    ["a negative start", 0, 99, "bytes -0-99/1000", FILE.slice(0, 100)],
  ])("refuses %s", async (_n, s, e, cr, body) => {
    await expect(getRange(req(s, e, answer(206, body as Uint8Array<ArrayBuffer>, cr)))).rejects.toBeInstanceOf(AefDownloadError);
  });

  it("refuses a total that differs from the size given by earlier answers (file changed mid-download)", async () => {
    await expect(getRange(req(0, 99, answer(206, FILE.slice(0, 100), "bytes 0-99/1001"), 1000))).rejects.toThrow(MSG);
    await expect(getRange(req(0, 99, answer(206, FILE.slice(0, 100), "bytes 0-99/1000"), 1000))).resolves.toBeDefined();
  });

  it("refuses a body shorter or longer than the Content-Range", async () => {
    await expect(getRange(req(0, 99, answer(206, FILE.slice(0, 99), "bytes 0-99/1000")))).rejects.toThrow(MSG);
    await expect(getRange(req(0, 99, answer(206, FILE.slice(0, 101), "bytes 0-99/1000")))).rejects.toThrow(MSG);
    await expect(getRange(req(0, 99, answer(206, null, "bytes 0-99/1000")))).rejects.toThrow(MSG);
  });

  it("sends exactly one credential-less GET with the asked Range", async () => {
    const calls: RequestInit[] = [];
    const f = (async (_u: string, init: RequestInit) => { calls.push(init); return new Response(FILE.slice(5, 10), { status: 206, headers: { "Content-Range": "bytes 5-9/1000" } }); }) as unknown as typeof fetch;
    await getRange(req(5, 9, f));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.credentials).toBe("omit");
    expect(new Headers(calls[0]!.headers).get("range")).toBe("bytes=5-9");
  });
});

describe("30 s no-progress timeout, fake timers (tester, F6)", () => {
  afterEach(() => { vi.useRealTimers(); });

  /** Settles-state probe for a promise under fake timers. */
  function track<T>(p: Promise<T>) {
    const s: { done: boolean; err: unknown; val: T | undefined } = { done: false, err: undefined, val: undefined };
    p.then((v) => { s.done = true; s.val = v; }, (e) => { s.done = true; s.err = e; });
    return s;
  }
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

  it("the default is 30 s", () => { expect(IDLE_TIMEOUT_MS).toBe(30_000); });

  it("no answer: still pending at 29.999 s, a download failure at 30 s, and the request is aborted", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const f = ((_u: string, init: RequestInit) => { signal = init.signal!; return new Promise(() => {}); }) as unknown as typeof fetch; // ignores abort
    const s = track(getRange(req(0, 99, f)));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.done).toBe(true);
    expect(s.err).toBeInstanceOf(AefDownloadError);
    expect((s.err as Error).message).toBe(MSG);
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // no timer left behind
  });

  it("headers at 29 s, then body chunks every 29 s for over 2 minutes: not timed out", async () => {
    vi.useFakeTimers();
    const body = FILE.slice(0, 100);
    const f = (async () => {
      await sleep(29_000);
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(c) {
          await sleep(29_000);
          if (i >= body.length) { c.close(); return; }
          c.enqueue(body.slice(i, i + 20)); i += 20;
        },
      });
      return new Response(stream, { status: 206, headers: { "Content-Range": "bytes 0-99/1000" } });
    }) as unknown as typeof fetch;
    const s = track(getRange(req(0, 99, f)));
    await vi.advanceTimersByTimeAsync(29_000 * 7 + 10);
    expect(s.err).toBeUndefined();
    expect(s.done).toBe(true);
    expect(new Uint8Array(s.val!.body)).toEqual(body);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a body that stalls after one chunk fails 30 s after that chunk, not before", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const f = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(c) { await sleep(10_000); c.enqueue(FILE.slice(0, 10)); },
        cancel() { cancelled = true; },
      });
      return new Response(stream, { status: 206, headers: { "Content-Range": "bytes 0-99/1000" } });
    }) as unknown as typeof fetch;
    const s = track(getRange(req(0, 99, f)));
    await vi.advanceTimersByTimeAsync(10_000 + 29_999);
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.err).toBeInstanceOf(AefDownloadError);
    expect(cancelled).toBe(true);
  });

  it("an outer abort (fail-fast from another request) ends the request at once with the abort reason wrapped", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const f = (() => new Promise(() => {})) as unknown as typeof fetch;
    const s = track(getRange(req(0, 99, f, null, { signal: ctl.signal })));
    await vi.advanceTimersByTimeAsync(5);
    ctl.abort(new AefDownloadError("aef.test", new Error("other request failed")));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.err).toBeInstanceOf(AefDownloadError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
