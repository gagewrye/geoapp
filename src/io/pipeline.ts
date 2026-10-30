import { crossesAntimeridian, projString } from "../core/crs";
import { decimatedAffine, decimatedTile, decimateInto, decimationFactor, type SourceWindow } from "../core/decimate";
import { tileWindows, type Window } from "../core/grid";
import { displaySamples } from "../core/alpha";
import { blockWindows, decodedBytes, MAX_BLOCK_BYTES, type Block } from "../core/imagery";
import { warpPreview } from "../core/warp";
import type { RasterSource } from "./source";

export class RasterRefusedError extends Error {
  constructor(readonly reason: "antimeridian" | "crs", message: string) {
    super(message);
  }
}

/** Refuse unsupported rasters from metadata alone, before any tile is read. */
export async function openRaster(source: Pick<RasterSource, "meta">): Promise<void> {
  const { epsg, gt, width, height } = source.meta;
  try {
    projString(epsg);
  } catch (e) {
    throw new RasterRefusedError("crs", (e as Error).message);
  }
  if (crossesAntimeridian(epsg, gt, width, height)) throw new RasterRefusedError("antimeridian", "Raster extent crosses 180 degrees");
}

export type PreviewOptions = {
  /** Fixed value range for every band; see warpPreview. */
  stretch?: [number, number];
  /** After each read: `done` of `total` reads. */
  onProgress?: (done: number, total: number) => void;
  /** Aborting stops the reads before the next one starts. */
  signal?: AbortSignal;
};

// Always an AbortError, whatever reason the signal was aborted with, so callers can tell it from a read error
const checkAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("Preview aborted", "AbortError");
};

/** Pause before the warp when progress is reported, a little over one 60 Hz frame. */
const FRAME_YIELD_MS = 20;

/** Spec 025: preview reads in flight when each decodes at most PARALLEL_BYTES, so their block fetches share file reads. */
const PARALLEL_READS = 4, PARALLEL_BYTES = 4 * 2 ** 20;

/** Decimate read by read, then warp to a Mercator-aligned RGBA preview. */
export async function buildPreview(source: RasterSource, maxSide: number, { stretch, onProgress, signal }: PreviewOptions = {}) {
  const { dec, gt, f, reads, inFlight } = previewReads(source, maxSide, signal);
  let next = 0, done = 0, failed = false;
  // windows don't overlap, so reads may finish and decimate in any order
  const worker = async () => {
    try {
      while (next < reads.length && !failed) {
        checkAborted(signal);
        const tile = await reads[next++]!();
        // once the call has rejected, reads still in flight report nothing: the caller has moved on
        if (failed) return;
        decimateInto(dec.tile, tile, f, dec.size[0]!, dec.size[1]!);
        onProgress?.(++done, reads.length);
      }
    } catch (e) {
      failed = true;
      throw e;
    }
  };
  await Promise.all(Array.from({ length: Math.min(inFlight, reads.length) }, worker));
  // For the caller's display: the warp blocks the main thread, so this usually yields past a frame (at 60 Hz) to draw the last progress first
  if (onProgress) await new Promise((r) => setTimeout(r, FRAME_YIELD_MS));
  checkAborted(signal);
  return warpPreview(dec.tile, gt, source.meta.epsg, maxSide, stretch);
}

/**
 * What the preview reads, without reading: the decimated tile to fill, its geotransform, the step f over the image read
 * (of size dec.size), one read per window, and how many reads may be in flight.
 */
function previewReads(source: RasterSource, maxSide: number, signal?: AbortSignal) {
  const { width, height, bandCount, gt, nodata, alpha } = source.meta;
  const bands = displaySamples(bandCount, alpha);
  const nb = bands.length, a = alpha === null ? null : nb - 1; // alpha's index in the decimated tile
  const { block, readSamples, overviews = [] } = source;
  const samples = (image: number, w: Window) => async (): Promise<SourceWindow> =>
    ({ ...w, bands: await readSamples!.call(source, image, w.x0, w.y0, w.width, w.height, bands, signal) });
  // spec 020: the smallest overview with a longest side of at least maxSide stands in for the image
  const ov = overviews.filter((o) => Math.max(o.width, o.height) >= maxSide).sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (ov && readSamples) {
    const f = decimationFactor(ov.width, ov.height, maxSide);
    const fx = width / ov.width, fy = height / ov.height;
    const windows = tileWindows(ov.width, ov.height);
    return {
      dec: { tile: decimatedTile(ov.width, ov.height, f, nb, nodata, a), size: [ov.width, ov.height] }, f,
      gt: decimatedAffine([gt[0], gt[1] * fx, gt[2] * fy, gt[3], gt[4] * fx, gt[5] * fy], f),
      reads: windows.map((w) => samples(ov.index, w)), inFlight: inFlightFor(windows, ov.block, ov.width, ov.height),
    };
  }
  const f = decimationFactor(width, height, maxSide);
  // spec 020: only the blocks holding a sampled pixel, each decoded once, cropped to its sampled span. A block over
  // MAX_BLOCK_BYTES (a single strip) is read in 256 px windows instead (A1): each decodes the block again, but output stays small.
  const fromWindow = (w: Window) => async (): Promise<SourceWindow> => {
    const t = await source.readWindow(w.x0, w.y0, w.width, w.height);
    return { ...w, bands: bands.map((k) => t.bands[k]!) };
  };
  const dec = { tile: decimatedTile(width, height, f, nb, nodata, a), size: [width, height] }, decGt = decimatedAffine(gt, f);
  if (!readSamples) return { dec, f, gt: decGt, reads: tileWindows(width, height).map(fromWindow), inFlight: 1 };
  const windows = block && block.bytes <= MAX_BLOCK_BYTES ? blockWindows(width, height, block.width, block.height, f) : tileWindows(width, height);
  return { dec, f, gt: decGt, reads: windows.map((w) => samples(0, w)), inFlight: inFlightFor(windows, block, width, height) };
}

/** PARALLEL_READS when every window's blocks decode to at most PARALLEL_BYTES; 1 when that's unknown (no block). */
const inFlightFor = (windows: Window[], block: Block | undefined, width: number, height: number) =>
  block && windows.every((w) => decodedBytes(w, block, width, height) <= PARALLEL_BYTES) ? PARALLEL_READS : 1;
