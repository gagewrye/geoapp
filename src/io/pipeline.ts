import { crossesAntimeridian, projString } from "../core/crs";
import { decimatedAffine, decimatedTile, decimateInto, decimationFactor, type SourceWindow } from "../core/decimate";
import { tileWindows, type Window } from "../core/grid";
import { blockWindows } from "../core/imagery";
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
  /** Aborting stops the reads before the next one. */
  signal?: AbortSignal;
};

// Always an AbortError, whatever reason the signal was aborted with, so callers can tell it from a read error
const checkAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("Preview aborted", "AbortError");
};

/** Pause before the warp when progress is reported, a little over one 60 Hz frame. */
const FRAME_YIELD_MS = 20;

/** Decimate read by read, then warp to a Mercator-aligned RGBA preview. */
export async function buildPreview(source: RasterSource, maxSide: number, { stretch, onProgress, signal }: PreviewOptions = {}) {
  const { dec, gt, f, reads } = previewReads(source, maxSide, signal);
  for (const [i, read] of reads.entries()) {
    checkAborted(signal);
    decimateInto(dec.tile, await read(), f, dec.size[0]!, dec.size[1]!);
    onProgress?.(i + 1, reads.length);
  }
  // For the caller's display: the warp blocks the main thread, so this usually yields past a frame (at 60 Hz) to draw the last progress first
  if (onProgress) await new Promise((r) => setTimeout(r, FRAME_YIELD_MS));
  checkAborted(signal);
  return warpPreview(dec.tile, gt, source.meta.epsg, maxSide, stretch);
}

/**
 * What the preview reads, without reading: the decimated tile to fill, its geotransform, the step f over the image read
 * (of size dec.size), and one read per window.
 */
function previewReads(source: RasterSource, maxSide: number, signal?: AbortSignal) {
  const { width, height, bandCount, gt, nodata } = source.meta;
  const nb = bandCount >= 3 ? 3 : 1;
  const bands = nb === 3 ? [0, 1, 2] : [0];
  const { block, readSamples, overviews = [] } = source;
  const samples = (image: number, w: Window) => async (): Promise<SourceWindow> =>
    ({ ...w, bands: await readSamples!.call(source, image, w.x0, w.y0, w.width, w.height, bands, signal) });
  // spec 020: the smallest overview with a longest side of at least maxSide stands in for the image
  const ov = overviews.filter((o) => Math.max(o.width, o.height) >= maxSide).sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (ov && readSamples) {
    const f = decimationFactor(ov.width, ov.height, maxSide);
    const fx = width / ov.width, fy = height / ov.height;
    return {
      dec: { tile: decimatedTile(ov.width, ov.height, f, nb, nodata), size: [ov.width, ov.height] }, f,
      gt: decimatedAffine([gt[0], gt[1] * fx, gt[2] * fy, gt[3], gt[4] * fx, gt[5] * fy], f),
      reads: tileWindows(ov.width, ov.height).map((w) => samples(ov.index, w)),
    };
  }
  const f = decimationFactor(width, height, maxSide);
  // spec 020: only the blocks holding a sampled pixel, each decoded once, cropped to its sampled span
  const reads = block && readSamples
    ? blockWindows(width, height, block.width, block.height, f).map((w) => samples(0, w))
    : tileWindows(width, height).map((w) => () => source.readWindow(w.x0, w.y0, w.width, w.height));
  return { dec: { tile: decimatedTile(width, height, f, nb, nodata), size: [width, height] }, f, gt: decimatedAffine(gt, f), reads };
}
