// The ORT worker (ADR 0031): SAM 2.1 Tiny's encoder and decoder on WebGPU only, holding one embedding.
// ORT is imported here, dynamically, so neither the main bundle nor this worker's first load contains it.
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { InferenceSession, Tensor } from "onnxruntime-web/webgpu";
import { SAM_SIDE } from "../core/smart";

type Ort = typeof import("onnxruntime-web/webgpu");
type Msg = { id: number } & ({ type: "load"; files: Uint8Array[] } | { type: "encode"; input: Float32Array } | { type: "decode"; points: Float32Array; labels: Uint8Array });
type Scope = { onmessage: ((e: MessageEvent<Msg>) => void) | null; postMessage(m: unknown, transfer?: Transferable[]): void };
type Gpu = { requestAdapter(): Promise<{ features: { has(f: string): boolean } } | null> };

const scope = self as unknown as Scope;
let ort: Ort, encoder: InferenceSession, decoder: InferenceSession;
let embedding: InferenceSession.OnnxValueMapType | null = null;

async function load([enc, encData, dec, decData]: Uint8Array[]): Promise<"ok" | "no-webgpu"> {
  // WorkerNavigator.gpu isn't Baseline: check it here too, before ORT would fall back with only a warning
  const gpu = (navigator as unknown as { gpu?: Gpu }).gpu;
  const adapter = await gpu?.requestAdapter().catch(() => null);
  if (!adapter?.features.has("shader-f16")) return "no-webgpu";
  ort = await import("onnxruntime-web/webgpu");
  ort.env.wasm.wasmPaths = { wasm: wasmUrl }; // same origin, bundled by Vite
  ort.env.wasm.numThreads = 1; // a static host can't make the page cross-origin isolated
  const session = (model: Uint8Array, path: string, data: Uint8Array) =>
    ort.InferenceSession.create(model, { executionProviders: ["webgpu"], externalData: [{ path, data }] });
  encoder = await session(enc!, "vision_encoder_fp16.onnx_data", encData!);
  decoder = await session(dec!, "prompt_encoder_mask_decoder_fp16.onnx_data", decData!);
  return "ok";
}

async function encode(input: Float32Array): Promise<null> {
  const old = embedding;
  embedding = null;
  for (const t of Object.values(old ?? {})) (t as Tensor).dispose();
  embedding = await encoder.run({ pixel_values: new ort.Tensor("float32", input, [1, 3, SAM_SIDE, SAM_SIDE]) });
  return null;
}

async function decode(points: Float32Array, labels: Uint8Array) {
  if (!embedding) throw new Error("No image is encoded.");
  const n = labels.length;
  const feeds: Record<string, Tensor> = {
    input_points: new ort.Tensor("float32", points, [1, 1, n, 2]),
    input_labels: new ort.Tensor("int64", BigInt64Array.from(labels, (v) => BigInt(v)), [1, 1, n]),
    input_boxes: new ort.Tensor("float32", new Float32Array(0), [1, 0, 4]),
  };
  for (const name of decoder.inputNames) if (name in embedding) feeds[name] = embedding[name] as Tensor;
  const out = await decoder.run(feeds);
  const masks = out.pred_masks as Tensor, scores = out.iou_scores as Tensor;
  const value = { masks: new Float32Array(masks.data as Float32Array), scores: new Float32Array(scores.data as Float32Array), side: masks.dims.at(-1)! };
  for (const t of Object.values(out)) (t as Tensor).dispose();
  return value;
}

// One message at a time, in order, so an encode and the decodes after it see the same embedding
let queue: Promise<void> = Promise.resolve();
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const value = data.type === "load" ? await load(data.files) : data.type === "encode" ? await encode(data.input) : await decode(data.points, data.labels);
      const transfer = value && typeof value === "object" ? [value.masks.buffer, value.scores.buffer] : [];
      scope.postMessage({ id: data.id, ok: true, value }, transfer);
    } catch (e) {
      scope.postMessage({ id: data.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
};
