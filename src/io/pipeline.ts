import { crossesAntimeridian, projString } from "../core/crs";
import { decimatedAffine, decimatedTile, decimateInto, decimationFactor } from "../core/decimate";
import { fit } from "../core/fit";
import { tileWindows, windowsIntersecting } from "../core/grid";
import { toPixelPolygons } from "../core/polygons";
import { predictTile } from "../core/predict";
import { bbox } from "../core/rasterize";
import { samplePixels } from "../core/sample";
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

/** Decimate window by window, then warp to a Mercator-aligned RGBA preview. */
export async function buildPreview(source: RasterSource, maxSide: number) {
  const { width, height, bandCount, gt, epsg, nodata } = source.meta;
  const f = decimationFactor(width, height, maxSide);
  const dec = decimatedTile(width, height, f, bandCount >= 3 ? 3 : 1, nodata);
  for (const w of tileWindows(width, height)) decimateInto(dec, await source.readWindow(w.x0, w.y0, w.width, w.height), f, width, height);
  return warpPreview(dec, decimatedAffine(gt, f), epsg, maxSide);
}

type Feature = GeoJSON.Feature<GeoJSON.Polygon, { label: number }>;

/** Sample only windows touching a polygon bbox, then fit on all bands. */
export async function train(source: RasterSource, features: Feature[], classes: string[],
  opts?: { epochs?: number; lr?: number; l2?: number }): Promise<{ model: Model; samples: number }> {
  const { width, height, bandCount, gt, epsg } = source.meta;
  const bands = Array.from({ length: bandCount }, (_, i) => i + 1);
  const polys = toPixelPolygons(features, epsg, gt);
  const Xs: Float32Array[] = [];
  const ys: Uint8Array[] = [];
  for (const w of windowsIntersecting(width, height, polys.map(bbox))) {
    const s = samplePixels(await source.readWindow(w.x0, w.y0, w.width, w.height), polys, bands);
    Xs.push(s.X);
    ys.push(s.y);
  }
  const X = concat(Xs, Float32Array);
  const y = concat(ys, Uint8Array);
  return { model: fit(X, y, bands, classes, opts), samples: y.length };
}

function concat<T extends Float32Array | Uint8Array>(parts: T[], C: new (n: number) => T): T {
  const out = new C(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Predict window by window and stream the classified GeoTIFF to the sink. */
export async function classify(source: RasterSource, model: Model, sink: Sink): Promise<void> {
  const { width, height, bandCount, geoTags } = source.meta;
  validate(model, bandCount);
  tiffLayout(width, height, geoTags); // reject oversize output before any read
  await writeTiff(sink, width, height, geoTags, async (w) => predictTile(model, await source.readWindow(w.x0, w.y0, w.width, w.height)));
}
