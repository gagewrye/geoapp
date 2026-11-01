# 0032: SAM 2.1 Hiera Tiny (fp16 ONNX), served same-origin and cached in Cache Storage

**Status:** Accepted (Gage, 2026-10-31), with spec 046.

**Context:** Smart select needs a promptable SAM-family model whose weights we can host as static files. Checked 2026-10-31:
- **SAM 2.1 Tiny:** about 38.9M parameters. Code and checkpoints are Apache-2.0 ([sam2](https://github.com/facebookresearch/sam2)). [onnx-community/sam2.1-hiera-tiny-ONNX](https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX) at sha 814a066 has separate encoder and decoder files: `vision_encoder_fp16` at 67 MB and `prompt_encoder_mask_decoder_fp16` at 10.5 MB, with fp32 at 134 MB. It takes a 1024² input with ImageNet mean and std, returns 256² masks, and gives 3 multimask outputs. The repo shows no licence, so the upstream one applies.
- **SlimSAM-77** (Apache-2.0): Xenova's ONNX files are 12.2 MB plus 8.55 MB at fp16.
- **MobileSAM** and **EfficientSAM** are Apache-2.0, but have no maintained browser ONNX.
- **EdgeTAM** is Apache-2.0, with an official CoreML export only.
- **SAM 3** is under Meta's SAM License, which is not open.
- **Latency:** no browser benchmark was found for SAM 2.1 Tiny. One ONNX card (SharpAI) claims 2–3 s per encode on Chrome WebGPU, without naming the hardware.
- SAM's own `export_onnx_model.py` exports only the decoder, so the encoders come from the Optimum and transformers.js conversions or from samexporter.

**Decision:** Use the onnx-community fp16 files at that sha. `npm run fetch-model` downloads them into the gitignored `public/models/sam2.1-hiera-tiny/` and checks their sha256 values, recorded in the script. They also ship with the upstream LICENSE. The browser fetches them from our origin once and keeps them in Cache Storage, under a cache name that holds the sha.

**Consequences:** A first use downloads about 78 MB plus the ORT wasm. Each file is under GitHub's 100 MB limit. Deploy must run the fetch first (spec 041). At the peak, memory adds about 12 MiB for the input tensor, about 16 MiB for the fp32 embedding in the worker, and about 80 MB of GPU weights. A model swap changes only the fetch script and `samInput`'s constants.
