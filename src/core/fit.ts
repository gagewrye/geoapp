import { EPS, type Model } from "./types";

/** Multinomial logistic regression by full-batch gradient descent on standardized bands. */
export function fit(X: Float32Array, y: Uint8Array, bands: number[], classes: string[],
  opts: { epochs?: number; lr?: number; l2?: number } = {}): Model {
  const { epochs = 300, lr = 0.5, l2 = 1e-4 } = opts;
  const d = bands.length;
  const k = classes.length;
  const n = y.length;
  // Labels are Uint8 and 255 is the nodata output, so 255 classes is the most that fit.
  if (k < 2 || k > 255) throw new Error(`fit: need 2..255 classes, got ${k}`);
  if (n === 0) throw new Error("No training samples: no raster pixels fall inside the polygons");
  if (X.length !== n * d) throw new Error(`fit: X has ${X.length} values, expected ${n * d}`);
  for (let i = 0; i < n; i++) if (y[i]! >= k) throw new Error(`fit: label ${y[i]} has no class`);
  // One infinite or NaN value would turn the whole model into NaN.
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) {
    if (!Number.isFinite(X[i * d + j]!)) throw new Error(`fit: sample ${i} band ${bands[j]} is not finite`);
  }

  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) mean[j]! += X[i * d + j]!;
  for (let j = 0; j < d; j++) mean[j]! /= n;
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) std[j]! += (X[i * d + j]! - mean[j]!) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.max(Math.sqrt(std[j]! / n), EPS);

  const W = new Float64Array(k * d);
  const b = new Float64Array(k);
  const gW = new Float64Array(k * d);
  const gb = new Float64Array(k);
  const z = new Float64Array(d);
  const p = new Float64Array(k);
  for (let e = 0; e < epochs; e++) {
    gW.fill(0); gb.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < d; j++) z[j] = (X[i * d + j]! - mean[j]!) / std[j]!;
      let max = -Infinity;
      for (let c = 0; c < k; c++) {
        let v = b[c]!;
        for (let j = 0; j < d; j++) v += W[c * d + j]! * z[j]!;
        p[c] = v;
        if (v > max) max = v;
      }
      let sum = 0;
      for (let c = 0; c < k; c++) { p[c] = Math.exp(p[c]! - max); sum += p[c]!; }
      for (let c = 0; c < k; c++) {
        const g = p[c]! / sum - (y[i] === c ? 1 : 0);
        gb[c]! += g;
        for (let j = 0; j < d; j++) gW[c * d + j]! += g * z[j]!;
      }
    }
    for (let c = 0; c < k; c++) {
      b[c]! -= (lr * gb[c]!) / n;
      for (let j = 0; j < d; j++) W[c * d + j]! -= lr * (gW[c * d + j]! / n + l2 * W[c * d + j]!);
    }
  }
  return {
    version: 1, type: "logreg", bands: [...bands], mean, std, classes: [...classes],
    W: Array.from({ length: k }, (_, c) => Array.from(W.subarray(c * d, (c + 1) * d))),
    b: Array.from(b),
  };
}
