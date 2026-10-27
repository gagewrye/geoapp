import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AEF_BANDS, dequantize } from "../../../src/core/aef";
import { fit } from "../../../src/core/fit";
import { predictTile } from "../../../src/core/predict";

const DIR = "tests/fixtures/aef/pixels";
const ref = JSON.parse(readFileSync(`${DIR}/ref.json`, "utf8")) as { mangrove: number; labels: number[]; mangrove_iou: number; accuracy: number };
const read = (name: string) => readFileSync(`${DIR}/${name}`);

/** Pixel-major samples [n][64] dequantized, and labels 1..11 shifted to class indices 0..10. */
function load(split: "train" | "test") {
  const q = read(`${split}_x.i8`);
  const X = new Float32Array(q.length);
  dequantize(new Int8Array(q.buffer, q.byteOffset, q.length), X);
  const y = Uint8Array.from(read(`${split}_y.u8`), (v) => v - 1);
  return { X, y };
}

describe("fit on AEF fixture pixels (criterion 10)", () => {
  it("reaches the sklearn reference mangrove IoU and accuracy within 0.02", () => {
    const train = load("train");
    const test = load("test");
    const bands = Array.from({ length: AEF_BANDS }, (_, i) => i + 1);
    const model = fit(train.X, train.y, bands, ref.labels.map(String));
    expect(model.classes).toHaveLength(11);
    // test pixels as a one-row tile: band k holds every pixel's value for band k
    const n = test.y.length;
    const tile = { x0: 0, y0: 0, width: n, height: 1, nodata: null,
      bands: bands.map((_, k) => Float32Array.from({ length: n }, (_, i) => test.X[i * AEF_BANDS + k]!)) };
    const pred = predictTile(model, tile);
    const m = ref.mangrove - 1;
    let tp = 0, union = 0, correct = 0;
    for (let i = 0; i < n; i++) {
      const p = pred[i] === m, t = test.y[i] === m;
      if (p && t) tp++;
      if (p || t) union++;
      if (pred[i] === test.y[i]) correct++;
    }
    const iou = tp / union, accuracy = correct / n;
    expect(iou).toBeGreaterThanOrEqual(ref.mangrove_iou - 0.02);
    expect(accuracy).toBeGreaterThanOrEqual(ref.accuracy - 0.02);
  });
});
