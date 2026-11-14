import { cachedAll, fetchCached, pruneCache, type ModelFile } from "./modelCache";

/** A decode's masks: n masks of side² logits each over the encoder's SAM_SIDE², and one score per mask. */
export type Masks = { masks: Float32Array; scores: Float32Array; side: number };

/** SAM's encoder and decoder (spec 046): one held embedding, keyed by its window. */
export interface Segmenter {
  encode(input: Float32Array, key: string): Promise<void>;
  /** The embedding held is key's, and no newer encode is running. */
  has(key: string): boolean;
  /** Decodes the held embedding with points (x, y pairs in encoder pixels) and labels (1 include, 0 exclude). */
  decode(points: Float32Array, labels: Uint8Array): Promise<Masks>;
}

/** The fp16 files of ADR 0032, with their sizes in bytes. */
const FILES = [
  ["vision_encoder_fp16.onnx", 314925], ["vision_encoder_fp16.onnx_data", 67005504],
  ["prompt_encoder_mask_decoder_fp16.onnx", 229799], ["prompt_encoder_mask_decoder_fp16.onnx_data", 10454016],
] as const;
/** ADR 0035: the pinned Hugging Face revision of ADR 0032's sha. */
const MODEL_DIR = "https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/814a066640debee5a91e70aa401fb8e17e030503/onnx/";
export const MODEL_FILES: ModelFile[] = FILES.map(([name, bytes]) => ({ url: MODEL_DIR + name, bytes }));
export const MODEL_URLS = MODEL_FILES.map((f) => f.url);

type Gpu = { requestAdapter(): Promise<{ features: { has(f: string): boolean } } | null> };

/** A WebGPU adapter with shader-f16 exists (ADR 0031): ORT would otherwise drop WebGPU with only a console warning. */
export async function hasWebGpu(gpu = (globalThis.navigator as { gpu?: Gpu } | undefined)?.gpu): Promise<boolean> {
  if (!gpu) return false;
  try { return (await gpu.requestAdapter())?.features.has("shader-f16") ?? false; } catch { return false; }
}

/** The model files are all in Cache Storage, so a load fetches nothing. */
export const modelCached = () => cachedAll(MODEL_FILES).catch(() => false);

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/** Downloads (or reads from the cache) the model, then loads it in the ORT worker; progress counts bytes of all four files. */
export async function loadSegmenter(onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<Segmenter | "no-webgpu"> {
  // smartLoad's ensure() checked WebGPU before asking to download; the worker checks again where ORT runs
  const total = MODEL_FILES.reduce((n, f) => n + f.bytes, 0);
  await pruneCache(MODEL_FILES);
  const files: Uint8Array[] = [];
  let before = 0;
  for (const f of MODEL_FILES) {
    files.push(await fetchCached(f, (done) => onProgress(Math.min(before + done, total), total), signal));
    before += f.bytes;
  }
  signal.throwIfAborted();
  onProgress(total, total);

  const worker = new Worker(new URL("./segmenterWorker.ts", import.meta.url), { type: "module" });
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 0;
  const failAll = (e: Error) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
  worker.onmessage = (ev: MessageEvent<Reply>) => {
    const w = waiting.get(ev.data.id);
    waiting.delete(ev.data.id);
    if (ev.data.ok) w?.resolve(ev.data.value); else w?.reject(new Error(ev.data.error));
  };
  worker.onerror = (ev) => failAll(new Error(ev.message || "The smart select worker failed."));
  const call = (msg: object, transfer: Transferable[] = []) => new Promise<unknown>((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });

  const stop = () => { worker.terminate(); failAll(new DOMException("Cancelled.", "AbortError")); };
  signal.addEventListener("abort", stop, { once: true });
  let loaded: unknown;
  try {
    loaded = await call({ type: "load", files }, files.map((f) => f.buffer as ArrayBuffer));
  } catch (e) {
    worker.terminate();
    throw e;
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (loaded === "no-webgpu") { worker.terminate(); return "no-webgpu"; }

  // Encodes run in order in the worker; only the newest one's key counts as held once it ends
  let held: string | null = null, encodes = 0;
  return {
    async encode(input, key) {
      const n = ++encodes;
      held = null;
      await call({ type: "encode", input }, [input.buffer as ArrayBuffer]);
      if (n === encodes) held = key;
    },
    has: (key) => held === key,
    decode: (points, labels) => call({ type: "decode", points, labels }) as Promise<Masks>,
  };
}
