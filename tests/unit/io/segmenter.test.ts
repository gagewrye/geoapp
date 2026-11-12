import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CACHE, ModelFileError } from "../../../src/io/modelCache";
import { loadSegmenter, MODEL_FILES, MODEL_URLS } from "../../../src/io/segmenter";
import { fakes } from "../helpers/modelFakes";

// Spec 055 criteria 3 and 5: the model's four pinned Hugging Face files, and what loadSegmenter asks for.
const HF = "https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/814a066640debee5a91e70aa401fb8e17e030503/onnx/";

describe("MODEL_FILES", () => {
  it("are the four fp16 files at the pinned revision, with their sizes", () => {
    expect(MODEL_FILES).toEqual([
      { url: HF + "vision_encoder_fp16.onnx", bytes: 314925 },
      { url: HF + "vision_encoder_fp16.onnx_data", bytes: 67005504 },
      { url: HF + "prompt_encoder_mask_decoder_fp16.onnx", bytes: 229799 },
      { url: HF + "prompt_encoder_mask_decoder_fp16.onnx_data", bytes: 10454016 },
    ]);
    expect(MODEL_URLS).toEqual(MODEL_FILES.map((f) => f.url));
  });
});

describe("loadSegmenter", () => {
  let f: ReturnType<typeof fakes>;
  beforeEach(() => {
    f = fakes();
    vi.stubGlobal("caches", f.caches);
    vi.stubGlobal("fetch", f.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("prunes unlisted entries first, then GETs a MODEL_FILES URL without credentials or referrer (criteria 3, 5)", async () => {
    const old = "https://app.test/models/sam2.1-hiera-tiny/vision_encoder_fp16.onnx";
    await (await caches.open(MODEL_CACHE)).put(old, new Response(new Uint8Array(4271)));
    f.serve.size = 4271; // an HTML page where a model file should be
    await expect(loadSegmenter(() => {}, new AbortController().signal)).rejects.toBeInstanceOf(ModelFileError);
    expect(f.stores.get(MODEL_CACHE)!.size).toBe(0);
    expect(f.calls.length).toBe(1);
    const { url, init } = f.calls[0]!;
    expect(url.startsWith(HF)).toBe(true);
    expect(MODEL_URLS).toContain(url);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
  });
});
