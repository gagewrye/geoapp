import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedAll, fetchCached, MODEL_CACHE, ModelFileError, pruneCache, type ModelFile } from "../../../src/io/modelCache";
import { fakes } from "../helpers/modelFakes";

// Spec 046 criterion 4 and spec 055 criteria 1-3: fetchCached with a fake Cache Storage and fetch.
const A: ModelFile = { url: "https://example.test/onnx/a.onnx", bytes: 12 };
const B: ModelFile = { url: "https://example.test/onnx/b.onnx", bytes: 12 };
const signal = () => new AbortController().signal;

describe("fetchCached", () => {
  let f: ReturnType<typeof fakes>;
  const stored = () => f.stores.get(MODEL_CACHE)?.size ?? 0;
  beforeEach(() => {
    f = fakes();
    vi.stubGlobal("caches", f.caches);
    vi.stubGlobal("fetch", f.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches once, with progress, and a second call reads only the cache (spec 046 criterion 4, 055 criterion 4)", async () => {
    const progress: [number, number][] = [];
    const a = await fetchCached(A, (done, total) => progress.push([done, total]), signal());
    expect([...a]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(progress).toEqual([[4, 12], [8, 12], [12, 12]]);
    expect(f.calls.map((c) => c.url)).toEqual([A.url]);
    expect(await cachedAll([A])).toBe(true);
    const b = await fetchCached(A, () => {}, signal());
    expect([...b]).toEqual([...a]);
    expect(f.calls.length).toBe(1);
    expect([...f.stores.keys()]).toEqual([MODEL_CACHE]);
  });

  it("a cancelled download rejects and stores nothing (spec 046 criterion 4)", async () => {
    const ac = new AbortController();
    await expect(fetchCached(A, () => ac.abort(), ac.signal)).rejects.toThrow();
    expect(stored()).toBe(0);
    expect(await cachedAll([A])).toBe(false);
  });

  it("a 200 with a 4271-byte body for a 12-byte file rejects with ModelFileError and stores nothing (criterion 1)", async () => {
    f.serve.size = 4271;
    const e = await fetchCached(A, () => {}, signal()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelFileError);
    expect((e as ModelFileError).url).toBe(A.url);
    expect((e as Error).message).toBe(`${A.url}: 4271 bytes, expected 12`);
    expect(stored()).toBe(0);
    expect(await cachedAll([A])).toBe(false);
  });

  it("a 404 rejects with ModelFileError and stores nothing (criterion 1)", async () => {
    f.serve.status = 404;
    const e = await fetchCached(A, () => {}, signal()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelFileError);
    expect((e as Error).message).toContain("404");
    expect(stored()).toBe(0);
    expect(await cachedAll([A])).toBe(false);
  });

  it("a wrong-sized entry makes cachedAll false; fetchCached then fetches once, returns and stores the bytes (criterion 2)", async () => {
    await (await caches.open(MODEL_CACHE)).put(A.url, new Response(new Uint8Array(4271)));
    await (await caches.open(MODEL_CACHE)).put(B.url, new Response(new Uint8Array(12)));
    expect(await cachedAll([B])).toBe(true);
    expect(await cachedAll([A, B])).toBe(false);
    const a = await fetchCached(A, () => {}, signal());
    expect(a.length).toBe(12);
    expect(f.calls.map((c) => c.url)).toEqual([A.url]);
    expect(f.stores.get(MODEL_CACHE)!.get(A.url)!.length).toBe(12);
    expect(await cachedAll([A, B])).toBe(true);
  });

  it("asks without credentials or a referrer (criterion 5)", async () => {
    await fetchCached(A, () => {}, signal());
    const init = f.calls[0]!.init!;
    expect(init.method ?? "GET").toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.headers).toBeUndefined();
  });
});

describe("pruneCache (criterion 3)", () => {
  let f: ReturnType<typeof fakes>;
  beforeEach(() => { f = fakes(); vi.stubGlobal("caches", f.caches); });
  afterEach(() => vi.unstubAllGlobals());

  it("deletes entries under unlisted URLs and keeps the listed ones", async () => {
    const c = await caches.open(MODEL_CACHE);
    const old = "https://app.test/models/sam2.1-hiera-tiny/a.onnx";
    for (const u of [A.url, B.url, old]) await c.put(u, new Response(new Uint8Array(12)));
    await pruneCache([A, B]);
    expect([...f.stores.get(MODEL_CACHE)!.keys()].sort()).toEqual([A.url, B.url]);
  });
});
