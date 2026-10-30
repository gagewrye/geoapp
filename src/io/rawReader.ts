import type { GeoTIFFImage } from "geotiff";
import type { Range } from "../core/ranges";
import { copySamples, rowRanges, type SampleArray } from "../core/raw";
import { browserBudget, TASK_BUDGET_MS, type Budget } from "./yieldTask";

/** Block offsets and byte counts of an image, loaded whole (spec 025). */
export type BlockOffsets = { offsets: Float64Array; counts: Float64Array };
/** geotiff.js's source contract, which blobSource implements. */
export type ByteSource = { fetch(slices: Range[], signal?: AbortSignal): Promise<ArrayBufferLike[]> };

// typed-array views read samples in the host's byte order
const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const WHOLE: Record<number, number[]> = { 1: [8, 16, 32], 2: [8, 16, 32], 3: [32, 64] };

const list = (v: unknown, n: number, d: number): number[] => (v === undefined || v === null ? Array<number>(n).fill(d) : typeof v === "number" ? [v] : Array.from(v as ArrayLike<number>));

/** The image can be read by rawWindow (ADR 0024): uncompressed, chunky, no predictor, whole-byte samples of one type, little-endian or 8-bit. */
export function rawEligible(image: GeoTIFFImage): boolean {
  const fd = image.fileDirectory, n = image.getSamplesPerPixel();
  const bits = list(fd.getValue("BitsPerSample"), n, 1), formats = list(fd.getValue("SampleFormat"), n, 1);
  const b = bits[0]!, f = formats[0]!;
  // geotiff.js types Predictor as deferred, but one SHORT is always stored inline, so it is read with the header
  const predictor = Number((fd.getValue as (tag: string) => unknown)("Predictor") ?? 1);
  return Number(fd.getValue("Compression") ?? 1) === 1 && image.planarConfiguration === 1 && predictor === 1
    && bits.length === n && bits.every((x) => x === b) && formats.every((x) => x === f) && (WHOLE[f] ?? []).includes(b)
    && (b === 8 || (image.littleEndian && HOST_LE));
}

/** The image's block offsets and byte counts as numbers (BigTIFF stores them as 64-bit). */
export async function rawOffsets(image: GeoTIFFImage): Promise<BlockOffsets> {
  const fd = image.fileDirectory;
  const [o, c] = image.isTiled ? (["TileOffsets", "TileByteCounts"] as const) : (["StripOffsets", "StripByteCounts"] as const);
  const [offsets, counts] = await Promise.all([fd.loadValue(o), fd.loadValue(c)]);
  return { offsets: Float64Array.from(offsets as ArrayLike<number>, Number), counts: Float64Array.from(counts as ArrayLike<number>, Number) };
}

/**
 * Samples `samples` of the window, as geotiff.js's readRasters returns them, reading only each row's bytes for the
 * window's columns in one fetch (ADR 0024); `image` must be rawEligible. The copy yields to the browser once `budget`'s 8 ms pass in a task.
 */
export async function rawWindow(image: GeoTIFFImage, source: ByteSource, offsets: BlockOffsets, x0: number, y0: number, w: number, h: number, samples: number[], signal?: AbortSignal, budget: Budget = browserBudget): Promise<SampleArray[]> {
  const spp = image.getSamplesPerPixel();
  for (const s of samples) if (s >= spp) throw new RangeError(`Invalid sample index '${s}'.`);
  const out = samples.map((s) => image.getArrayForSample(s, w * h) as SampleArray);
  if (out.length === 0) return out;
  const pieces = rowRanges({ width: image.getWidth(), height: image.getHeight(), blockWidth: image.getTileWidth(), blockHeight: image.getTileHeight(),
    bytesPerPixel: image.getBytesPerPixel(), ...offsets }, x0, y0, w, h);
  const stored = pieces.filter((p) => p.length > 0);
  const bufs = await source.fetch(stored, signal);
  signal?.throwIfAborted();
  const fill = image.getGDALNoData() || 0; // what geotiff.js fills a block stored with no bytes with
  let j = 0;
  let start = budget.now();
  for (const p of pieces) {
    // a wide read copies millions of samples: spread it over tasks (spec 028)
    if (budget.now() - start >= TASK_BUDGET_MS) {
      await budget.yieldTask();
      signal?.throwIfAborted();
      start = budget.now();
    }
    copySamples(p.length > 0 ? bufs[j++]! : new ArrayBuffer(0), p, spp, samples, out, x0, y0, w, fill);
  }
  return out;
}
