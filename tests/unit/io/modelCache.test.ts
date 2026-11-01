import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedAll, fetchCached, MODEL_CACHE } from "../../../src/io/modelCache";

// Spec 046 criterion 4: fetchCached with a fake Cache Storage and fetch.
const URL_A = "models/sam2.1-hiera-tiny/a.onnx";

function fakes() {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const caches = {
    async open(name: string) {
      const m = stores.get(name) ?? new Map<string, Uint8Array>();
      stores.set(name, m);
      return {
        async match(url: string) { const b = m.get(url); return b ? new Response(b.slice()) : undefined; },
        async put(url: string, r: Response) { m.set(url, new Uint8Array(await r.arrayBuffer())); },
      };
    },
  };
  const calls: string[] = [];
  /** Serves 3 chunks of 4 bytes; a signal aborted between chunks errors the body, as a real fetch does. */
  const fetch = async (url: string, init?: { signal?: AbortSignal }) => {
    calls.push(url);
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (init?.signal?.aborted) { c.error(new DOMException("aborted", "AbortError")); return; }
        if (i === 3) { c.close(); return; }
        c.enqueue(new Uint8Array(4).fill(++i));
      },
    });
    return new Response(body, { headers: { "content-length": "12" } });
  };
  return { stores, caches, fetch, calls };
}

describe("fetchCached (criterion 4)", () => {
  let f: ReturnType<typeof fakes>;
  beforeEach(() => {
    f = fakes();
    vi.stubGlobal("caches", f.caches);
    vi.stubGlobal("fetch", f.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches once, with progress, and a second call reads only the cache", async () => {
    const progress: [number, number][] = [];
    const a = await fetchCached(URL_A, (done, total) => progress.push([done, total]), new AbortController().signal);
    expect([...a]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(progress).toEqual([[4, 12], [8, 12], [12, 12]]);
    expect(f.calls).toEqual([URL_A]);
    expect(await cachedAll([URL_A])).toBe(true);
    const b = await fetchCached(URL_A, () => {}, new AbortController().signal);
    expect([...b]).toEqual([...a]);
    expect(f.calls).toEqual([URL_A]);
    expect([...f.stores.keys()]).toEqual([MODEL_CACHE]);
  });

  it("a cancelled download rejects and stores nothing", async () => {
    const ac = new AbortController();
    await expect(fetchCached(URL_A, () => ac.abort(), ac.signal)).rejects.toThrow();
    expect(f.stores.get(MODEL_CACHE)?.size ?? 0).toBe(0);
    expect(await cachedAll([URL_A])).toBe(false);
  });
});
