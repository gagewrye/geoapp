# 0031: onnxruntime-web, WebGPU only, in a worker, for smart select

**Status:** Accepted (Gage, 2026-10-31), with spec 046. This takes up ADR 0012 option (i) for one small model.

**Context:** Spec 046 runs a SAM encoder and decoder on the user's device, so nothing leaves it. Checked 2026-10-31:
- **onnxruntime-web 1.31.1** (MIT; npm `latest`) has a `./webgpu` export and depends on protobufjs, flatbuffers, long, platform, guid-typescript and onnxruntime-common.
- Its dist wasm files are 14–28 MB uncompressed. The `externalData` session option takes a Uint8Array, and the docs suggest the Cache API or OPFS for caching ([large models](https://onnxruntime.ai/docs/tutorials/web/large-models.html)).
- Threaded WASM needs `crossOriginIsolated`, and a static host can't send the COOP and COEP headers that give it ([env flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)). Microsoft's SAM ViT-B example takes about 45 s per encode on WASM; its decoder takes about 200 ms ([example](https://github.com/microsoft/onnxruntime-inference-examples/tree/main/js/segment-anything)).
- `WorkerNavigator.gpu` exists, though it isn't Baseline (MDN). `@huggingface/transformers` 4.3.2 wraps ORT, but it pins a dev build of ORT and lists sharp and onnxruntime-node.

**Decision:** Use onnxruntime-web 1.31.1, pinned exactly. Import `onnxruntime-web/webgpu` dynamically inside a module worker, and list only `executionProviders: ['webgpu']`. The worker checks `adapter.features.has("shader-f16")` itself first, because ORT otherwise drops WebGPU with only a console warning. The wasm file is bundled same-origin through `env.wasm.wasmPaths`. Pre- and post-processing are in `core/`. transformers.js isn't used.

**Consequences:** We add one runtime dependency, which is lazy, so the main bundle and spec 028's load are unchanged. There is no CPU path, so Smart is off without WebGPU: on Linux before Chromium 144/147, and on Firefox Linux (ADR 0012). The implementer records which wasm file the webgpu build loads and its gzip size. Upgrading ORT means re-running spec 046 criterion 9.
