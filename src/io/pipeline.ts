import { crossesAntimeridian, projString } from "../core/crs";
import { decimatedAffine, decimatedTile, decimateInto, decimationFactor } from "../core/decimate";
import { fit } from "../core/fit";
import { tileWindows } from "../core/grid";
import { labelSamples } from "../core/labelSamples";
import { labelWindows, type LabelStore } from "../core/labelStore";
import { predictTile } from "../core/predict";
import type { Model } from "../core/types";
import { validate } from "../core/validate";
import { warpPreview } from "../core/warp";
import { tiffLayout, writeTiff } from "./tiffWriter";
import type { RasterSource, Sink } from "./source";

export class RasterRefusedError extends Error {
  constructor(readonly reason: "antimeridian" | "crs", message: string) {
    super(message);
  }
}

/** Refuse unsupported rasters from metadata alone, before any tile is read. */
export async function openRaster(source: RasterSource): Promise<void> {
  const { epsg, gt, width, height } = source.meta;
  try {
    projString(epsg);
  } catch (e) {
    throw new RasterRefusedError("crs", (e as Error).message);
  }
  if (crossesAntimeridian(epsg, gt, width, height)) throw new RasterRefusedError("antimeridian", "Raster extent crosses 180 degrees");
}

/** Decimate window by window, then warp to a Mercator-aligned RGBA preview (stretch: see warpPreview). */
export async function buildPreview(source: RasterSource, maxSide: number, stretch?: [number, number]) {
  const { width, height, bandCount, gt, epsg, nodata } = source.meta;
  const f = decimationFactor(width, height, maxSide);
  const dec = decimatedTile(width, height, f, bandCount >= 3 ? 3 : 1, nodata);
  for (const w of tileWindows(width, height)) decimateInto(dec, await source.readWindow(w.x0, w.y0, w.width, w.height), f, width, height);
  return warpPreview(dec, decimatedAffine(gt, f), epsg, maxSide, stretch);
}

/**
 * Read each stored label tile's window once, sample it on all bands, and fit every class in the
 * list (spec 003). "no samples" when every labelled pixel is nodata.
 */
export async function train(source: RasterSource, store: LabelStore, classes: string[],
  opts?: { epochs?: number; lr?: number; l2?: number }): Promise<{ model: Model; samples: number } | "no samples"> {
  const bands = Array.from({ length: source.meta.bandCount }, (_, i) => i + 1);
  // The brush stays live while training reads, so train on the labels as they were when called:
  // copy every tile before the first await. Transient peak: one copy of the store, at most
  // MAX_LABEL_TILES x 64 KiB = 16 MiB, freed tile by tile as each window is sampled.
  const snapshot = labelWindows(store).map((w) => ({ w, labels: store.tiles.get(`${w.x0},${w.y0}`)!.slice() }));
  const Xs: Float32Array[] = [];
  const ys: Uint8Array[] = [];
  while (snapshot.length) {
    const { w, labels } = snapshot.shift()!;
    const s = labelSamples(await source.readWindow(w.x0, w.y0, w.width, w.height), labels, bands);
    Xs.push(s.X);
    ys.push(s.y);
  }
  const X = concat(Xs, Float32Array);
  const y = concat(ys, Uint8Array);
  if (!y.length) return "no samples";
  return { model: fit(X, y, bands, classes, opts), samples: y.length };
}

function concat<T extends Float32Array | Uint8Array>(parts: T[], C: new (n: number) => T): T {
  const out = new C(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Throw if the model doesn't fit the raster or the output exceeds classic TIFF; reads nothing. */
export function checkClassify(source: RasterSource, model: Model): void {
  const { width, height, bandCount, geoTags } = source.meta;
  validate(model, bandCount);
  tiffLayout(width, height, geoTags);
}

/** Predict window by window and stream the classified GeoTIFF to the sink. */
export async function classify(source: RasterSource, model: Model, sink: Sink): Promise<void> {
  const { width, height, geoTags } = source.meta;
  checkClassify(source, model); // reject before any read or write
  await writeTiff(sink, width, height, geoTags, async (w) => predictTile(model, await source.readWindow(w.x0, w.y0, w.width, w.height)));
}
