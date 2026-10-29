import { crossesAntimeridian, projString } from "../core/crs";
import { decimatedAffine, decimatedTile, decimateInto, decimationFactor } from "../core/decimate";
import { tileWindows } from "../core/grid";
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
  /** After each window read: `done` of `total` reads. */
  onProgress?: (done: number, total: number) => void;
  /** Aborting stops the reads before the next window. */
  signal?: AbortSignal;
};

// Always an AbortError, whatever reason the signal was aborted with, so callers can tell it from a read error
const checkAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("Preview aborted", "AbortError");
};

/** Pause before the warp when progress is reported, a little over one 60 Hz frame. */
const FRAME_YIELD_MS = 20;

/** Decimate window by window, then warp to a Mercator-aligned RGBA preview. */
export async function buildPreview(source: RasterSource, maxSide: number, { stretch, onProgress, signal }: PreviewOptions = {}) {
  const { width, height, bandCount, gt, epsg, nodata } = source.meta;
  const f = decimationFactor(width, height, maxSide);
  const dec = decimatedTile(width, height, f, bandCount >= 3 ? 3 : 1, nodata);
  const windows = tileWindows(width, height);
  for (const [i, w] of windows.entries()) {
    checkAborted(signal);
    decimateInto(dec, await source.readWindow(w.x0, w.y0, w.width, w.height), f, width, height);
    onProgress?.(i + 1, windows.length);
  }
  // For the caller's display: the warp blocks the main thread, so this usually yields past a frame (at 60 Hz) to draw the last progress first
  if (onProgress) await new Promise((r) => setTimeout(r, FRAME_YIELD_MS));
  checkAborted(signal);
  return warpPreview(dec, decimatedAffine(gt, f), epsg, maxSide, stretch);
}
