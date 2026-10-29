import { isNodata } from "./nodata";
import { NODATA_OUT, type Model, type Tile } from "./types";

/** Calls f(i, best, logits) on every valid pixel, or nodata(i) where a model band is nodata or NaN. */
// One loop for predictTile and seedFromModel, so best (the first maximum) is the same pick in both.
// logits is reused between pixels to spare an allocation per pixel; f must copy what it keeps.
function scan(model: Model, tile: Tile, f: (i: number, best: number, logits: Float64Array) => void, nodata: (i: number) => void): void {
  const { bands, mean, std, W, b } = model;
  const k = W.length;
  const d = bands.length;
  const n = tile.width * tile.height;
  const src = bands.map((band) => tile.bands[band - 1]!);
  const z = new Float64Array(d);
  const logits = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    if (isNodata(tile, bands, i)) { nodata(i); continue; }
    for (let j = 0; j < d; j++) z[j] = (src[j]![i]! - mean[j]!) / std[j]!;
    let best = 0;
    let bestV = -Infinity;
    for (let c = 0; c < k; c++) {
      const w = W[c]!;
      let v = b[c]!;
      for (let j = 0; j < d; j++) v += w[j]! * z[j]!;
      logits[c] = v;
      if (v > bestV) { bestV = v; best = c; }
    }
    f(i, best, logits);
  }
}

/** Class index per pixel (softmax argmax == logit argmax); 255 = nodata. */
export function predictTile(model: Model, tile: Tile): Uint8Array {
  const out = new Uint8Array(tile.width * tile.height);
  scan(model, tile, (i, best) => { out[i] = best; }, (i) => { out[i] = NODATA_OUT; });
  return out;
}

/** values[argmax] where the max softmax is >= minProb, else 0; nodata -> 0 (spec 004). */
export function seedFromModel(model: Model, tile: Tile, minProb: number, values: number[]): Uint8Array {
  const out = new Uint8Array(tile.width * tile.height);
  scan(model, tile, (i, best, logits) => {
    // max softmax = 1 / sum(exp(l - l_max)), which can't overflow. An infinite pixel can make l_max
    // infinite (l - l_max NaN: the logits equal to it count 1 each) or a logit NaN (0 * Infinity,
    // never predictTile's pick: it counts 0). All NaN tells nothing, so uniform.
    const top = logits[best]!;
    let sum = 0;
    for (const l of logits) {
      if (l === top) sum += 1;
      else if (l < top) sum += Math.exp(l - top);
    }
    if ((sum > 0 ? 1 / sum : 1 / logits.length) >= minProb) out[i] = values[best]!;
  }, () => {});
  return out;
}
