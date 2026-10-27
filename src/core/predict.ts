import { isNodata } from "./nodata";
import { NODATA_OUT, type Model, type Tile } from "./types";

/** Class index per pixel (softmax argmax == logit argmax); 255 = nodata. */
export function predictTile(model: Model, tile: Tile): Uint8Array {
  const { bands, mean, std, W, b } = model;
  const k = W.length;
  const d = bands.length;
  const n = tile.width * tile.height;
  const out = new Uint8Array(n);
  const src = bands.map((band) => tile.bands[band - 1]!);
  const z = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    if (isNodata(tile, bands, i)) { out[i] = NODATA_OUT; continue; }
    for (let j = 0; j < d; j++) z[j] = (src[j]![i]! - mean[j]!) / std[j]!;
    let best = 0;
    let bestV = -Infinity;
    for (let c = 0; c < k; c++) {
      const w = W[c]!;
      let v = b[c]!;
      for (let j = 0; j < d; j++) v += w[j]! * z[j]!;
      if (v > bestV) { bestV = v; best = c; }
    }
    out[i] = best;
  }
  return out;
}
