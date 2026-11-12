import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedAll, fetchCached, MODEL_CACHE, ModelFileError, pruneCache, type ModelFile } from "../../../src/io/modelCache";
import { fakes } from "../helpers/modelFakes";

// Spec 055 criteria 1-4, tester edge cases: off-by-one sizes, empty bodies, network errors, a hit that is wrong-sized, and
// the "doesn't keep a file's bytes" rule checked structurally (no arrayBuffer on the check path).
const A: ModelFile = { url: "https://example.test/onnx/a.onnx", bytes: 12 };
const B: ModelFile = { url: "https://example.test/onnx/b.onnx", bytes: 12 };
const signal = () => new AbortController().signal;

describe("fetchCached edges", () => {
  let f: ReturnType<typeof fakes>;
  const stored = () => f.stores.get(MODEL_CACHE)?.size ?? 0;
  beforeEach(() => { f = fakes(); vi.stubGlobal("caches", f.caches); vi.stubGlobal("fetch", f.fetch); });
  afterEach(() => vi.unstubAllGlobals());

  for (const size of [0, 11, 13]) {
    it(`a 200 with ${size} bytes for a 12-byte file rejects with ModelFileError and stores nothing`, async () => {
      f.serve.size = size;
      const e = await fetchCached(A, () => {}, signal()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ModelFileError);
      expect((e as Error).message).toBe(`${A.url}: ${size} bytes, expected 12`);
      expect(stored()).toBe(0);
      expect(await cachedAll([A])).toBe(false);
    });
  }

  for (const status of [403, 500]) {
    it(`an HTTP ${status} rejects with ModelFileError naming the URL and stores nothing`, async () => {
      f.serve.status = status;
      const e = await fetchCached(A, () => {}, signal()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ModelFileError);
      expect((e as ModelFileError).url).toBe(A.url);
      expect(stored()).toBe(0);
    });
  }

  it("a 200 with no body rejects with ModelFileError", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    await expect(fetchCached(A, () => {}, signal())).rejects.toBeInstanceOf(ModelFileError);
    expect(stored()).toBe(0);
  });

  it("a network failure is unchanged: the fetch's own error, not ModelFileError, and nothing stored", async () => {
    const boom = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", async () => { throw boom; });
    const e = await fetchCached(A, () => {}, signal()).catch((x: unknown) => x);
    expect(e).toBe(boom);
    expect(stored()).toBe(0);
  });

  it("a correct pre-seeded entry is read with no request (criterion 4)", async () => {
    await (await caches.open(MODEL_CACHE)).put(A.url, new Response(new Uint8Array(12).fill(7)));
    const b = await fetchCached(A, () => {}, signal());
    expect([...b]).toEqual(new Array(12).fill(7));
    expect(f.calls.length).toBe(0);
  });

  it("a wrong-sized entry hit by fetchCached itself (no cachedAll first) is replaced by one fetch (criterion 2)", async () => {
    await (await caches.open(MODEL_CACHE)).put(A.url, new Response(new Uint8Array(4271)));
    const a = await fetchCached(A, () => {}, signal());
    expect(a.length).toBe(12);
    expect(f.calls.length).toBe(1);
    expect(f.stores.get(MODEL_CACHE)!.get(A.url)!.length).toBe(12);
  });

  it("a wrong-sized entry, then a bad response, leaves the cache empty for that URL", async () => {
    await (await caches.open(MODEL_CACHE)).put(A.url, new Response(new Uint8Array(4271)));
    f.serve.size = 4271;
    await expect(fetchCached(A, () => {}, signal())).rejects.toBeInstanceOf(ModelFileError);
    expect(f.stores.get(MODEL_CACHE)!.has(A.url)).toBe(false);
  });

  it("progress totals are the file's size, not content-length", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(12), { headers: { "content-length": "999" } }));
    const totals: number[] = [];
    await fetchCached(A, (_d, t) => totals.push(t), signal());
    expect(new Set(totals)).toEqual(new Set([12]));
  });
});

describe("cachedAll does not hold a file's bytes (scope 3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A cache whose entries expose only a size; reading their bytes throws. */
  const sizedOnly = (sizes: Record<string, number>, deleted: string[]) => ({
    async open() {
      return {
        async match(url: string) {
          if (!(url in sizes)) return undefined;
          return {
            blob: async () => ({ size: sizes[url], arrayBuffer: () => { throw new Error("bytes read"); } }),
            arrayBuffer: () => { throw new Error("bytes read"); },
            bytes: () => { throw new Error("bytes read"); },
            text: () => { throw new Error("bytes read"); },
          };
        },
        async delete(url: string) { deleted.push(url); delete sizes[url]; return true; },
      };
    },
  });

  it("checks sizes without reading any entry's bytes, and deletes the wrong-sized one", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", sizedOnly({ [A.url]: 12, [B.url]: 4271 }, deleted));
    expect(await cachedAll([A])).toBe(true);
    expect(await cachedAll([A, B])).toBe(false);
    expect(deleted).toEqual([B.url]);
  });
});

describe("pruneCache edges (criterion 3)", () => {
  let f: ReturnType<typeof fakes>;
  beforeEach(() => { f = fakes(); vi.stubGlobal("caches", f.caches); });
  afterEach(() => vi.unstubAllGlobals());

  it("an empty cache stays empty, and a cache of only listed URLs is untouched", async () => {
    await pruneCache([A, B]);
    expect(f.stores.get(MODEL_CACHE)!.size).toBe(0);
    const c = await caches.open(MODEL_CACHE);
    await c.put(A.url, new Response(new Uint8Array(12)));
    await pruneCache([A, B]);
    expect([...f.stores.get(MODEL_CACHE)!.keys()]).toEqual([A.url]);
  });

  it("an empty list deletes every entry, and URLs differing only by query are not kept", async () => {
    const c = await caches.open(MODEL_CACHE);
    await c.put(A.url + "?download=true", new Response(new Uint8Array(12)));
    await c.put(B.url, new Response(new Uint8Array(12)));
    await pruneCache([A]);
    expect([...f.stores.get(MODEL_CACHE)!.keys()]).toEqual([]);
  });

  it("touches only MODEL_CACHE, not other caches", async () => {
    await (await caches.open("other")).put("https://x.test/y", new Response(new Uint8Array(1)));
    await pruneCache([A]);
    expect(f.stores.get("other")!.size).toBe(1);
  });
});
