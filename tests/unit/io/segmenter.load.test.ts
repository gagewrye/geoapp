import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CACHE, ModelFileError } from "../../../src/io/modelCache";
import { loadSegmenter, MODEL_FILES, modelCached } from "../../../src/io/segmenter";
import { fakes } from "../helpers/modelFakes";

// Spec 055 criteria 3 and 5: all four files fetched, each GET checked; prune runs before the first GET;
// a second load reads only the cache (the unit analogue of criterion 10's reload); a later bad file stops the load.
const HF = "https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/814a066640debee5a91e70aa401fb8e17e030503/onnx/";
const size = (url: string) => MODEL_FILES.find((f) => f.url === url)?.bytes ?? 0;

/** A worker whose load replies with `value`, and which records the files it was given. */
function workerReplying(value: unknown, got: number[][]) {
  return class {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    postMessage(msg: { id: number; type: string; files?: Uint8Array[] }) {
      if (msg.files) got.push(msg.files.map((f) => f.length));
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, value } }));
    }
    terminate() {}
  };
}

describe("loadSegmenter over all four files", () => {
  let f: ReturnType<typeof fakes>;
  const order: string[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let wrongAt: string | null = null;
  beforeEach(() => {
    f = fakes();
    order.length = 0; calls.length = 0; wrongAt = null;
    const c = f.caches;
    vi.stubGlobal("caches", {
      async open(name: string) {
        const cache = await c.open(name);
        return { ...cache, async delete(u: string | Request) { order.push("delete"); return cache.delete(u); } };
      },
    });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      order.push("fetch");
      calls.push({ url, init });
      return new Response(new Uint8Array(url === wrongAt ? 4271 : size(url)));
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("GETs each of the four URLs in order, each without credentials or referrer, after pruning; the worker gets their bytes", async () => {
    await (await caches.open(MODEL_CACHE)).put("http://localhost:4173/models/sam2.1-hiera-tiny/vision_encoder_fp16.onnx", new Response(new Uint8Array(314925)));
    const got: number[][] = [];
    vi.stubGlobal("Worker", workerReplying("no-webgpu", got));
    const progress: [number, number][] = [];
    expect(await loadSegmenter((d, t) => progress.push([d, t]), new AbortController().signal)).toBe("no-webgpu");
    expect(calls.map((c) => c.url)).toEqual(MODEL_FILES.map((m) => m.url));
    for (const { url, init } of calls) {
      expect(url.startsWith(HF)).toBe(true);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(init?.headers).toBeUndefined();
    }
    expect(order.indexOf("delete")).toBeLessThan(order.indexOf("fetch"));
    expect(got).toEqual([MODEL_FILES.map((m) => m.bytes)]);
    const total = MODEL_FILES.reduce((n, m) => n + m.bytes, 0);
    expect(progress.at(-1)).toEqual([total, total]);
    for (let i = 1; i < progress.length; i++) expect(progress[i]![0]).toBeGreaterThanOrEqual(progress[i - 1]![0]);
    expect(await modelCached()).toBe(true);
    expect([...f.stores.get(MODEL_CACHE)!.keys()].sort()).toEqual(MODEL_FILES.map((m) => m.url).sort());

    // a second load (a reload) requests nothing
    calls.length = 0;
    vi.stubGlobal("Worker", workerReplying("no-webgpu", got));
    await loadSegmenter(() => {}, new AbortController().signal);
    expect(calls).toEqual([]);
  });

  it("a wrong-sized third file stops the load with ModelFileError; the two good files stay cached, the bad one does not, and no worker starts", async () => {
    wrongAt = MODEL_FILES[2]!.url;
    const got: number[][] = [];
    vi.stubGlobal("Worker", workerReplying("ok", got));
    const e = await loadSegmenter(() => {}, new AbortController().signal).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelFileError);
    expect((e as Error).message).toBe(`${wrongAt}: 4271 bytes, expected ${MODEL_FILES[2]!.bytes}`);
    expect(calls.length).toBe(3);
    expect([...f.stores.get(MODEL_CACHE)!.keys()]).toEqual(MODEL_FILES.slice(0, 2).map((m) => m.url));
    expect(got).toEqual([]);
    expect(await modelCached()).toBe(false);
  });
});
