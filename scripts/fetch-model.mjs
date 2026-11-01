/* global console, process, fetch, URL */
// npm run fetch-model: SAM 2.1 Hiera Tiny's fp16 ONNX files (ADR 0032), at a pinned revision, into
// public/models/sam2.1-hiera-tiny/, each checked against its sha256. Files already there and intact are kept.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const REVISION = "814a066640debee5a91e70aa401fb8e17e030503";
const BASE = `https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/${REVISION}/onnx/`;
const DIR = new URL("../public/models/sam2.1-hiera-tiny/", import.meta.url);
const FILES = {
  "vision_encoder_fp16.onnx": "7773e79d589dada8e1e630cc7eb18b17b2c5b4faeb1eaab5ebf9df618ecbd50a",
  "vision_encoder_fp16.onnx_data": "a4dd3759e9b6a476d991fb3493787992e78777e51462695e1bede71ae258103e",
  "prompt_encoder_mask_decoder_fp16.onnx": "00ac7200451f246e8307aa1a1648113f47dc45625738406403a0e6b86c69fc55",
  "prompt_encoder_mask_decoder_fp16.onnx_data": "027b457a53f5bd76bb401c59555448451d04b4eab6d2f6a6758406b40133ee2c",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

await mkdir(DIR, { recursive: true });
for (const [name, want] of Object.entries(FILES)) {
  const path = new URL(name, DIR);
  const have = await readFile(path).catch(() => null);
  if (have && sha256(have) === want) { console.log(`${name}: present`); continue; }
  console.log(`${name}: downloading`);
  const res = await fetch(BASE + name);
  if (!res.ok) { console.error(`${name}: HTTP ${res.status}`); process.exit(1); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== want) { console.error(`${name}: sha256 ${got}, expected ${want}`); process.exit(1); }
  await writeFile(new URL(`${name}.part`, DIR), bytes);
  await rename(new URL(`${name}.part`, DIR), path); // a failed run never leaves a truncated file under the real name
  console.log(`${name}: ${bytes.length} bytes, sha256 ok`);
}
