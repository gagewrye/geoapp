import { describe, expect, it } from "vitest";
import { predictTile, seedFromModel } from "../../../src/core/predict";
import type { Model, Tile } from "../../../src/core/types";

// Spec 004 criterion 5, on spec 001 criterion 7's tile and model (predict.test.ts).

const model: Model = { version: 1, type: "logreg", bands: [1, 2], mean: [10, 20], std: [2, 4],
  classes: ["a", "b", "c"], W: [[1, 0], [0, 1], [-1, -1]], b: [0, 0, 0.5] };
const tile: Tile = { x0: 256, y0: 0, width: 3, height: 2, nodata: -9, bands: [
  new Float32Array([14, 10, 6, -9, NaN, 12]),
  new Float32Array([20, 32, 12, 20, 20, 28]),
  new Float32Array([-9, -9, -9, -9, -9, -9]),
] };

/** Max softmax per pixel, computed here from the logits by hand (NaN at nodata). */
function maxProb(i: number): number {
  const z = [(tile.bands[0]![i]! - 10) / 2, (tile.bands[1]![i]! - 20) / 4];
  const logits = model.W.map((w, c) => model.b[c]! + w[0]! * z[0]! + w[1]! * z[1]!);
  const m = Math.max(...logits);
  return 1 / logits.reduce((s, l) => s + Math.exp(l - m), 0);
}

describe("seedFromModel (criterion 5)", () => {
  const pred = [...predictTile(model, tile)];

  it("at minProb 0 equals predictTile + 1 with values 1..n, and 255 (nodata) -> 0", () => {
    expect([...seedFromModel(model, tile, 0, [1, 2, 3])]).toEqual(pred.map((p) => (p === 255 ? 0 : p + 1)));
    expect(pred).toContain(255);
  });

  it("with values reversed each pixel gets values[predictTile]", () => {
    const values = [3, 2, 1];
    expect([...seedFromModel(model, tile, 0, values)]).toEqual(pred.map((p) => (p === 255 ? 0 : values[p])));
  });

  it("at minProb 0.9 pixels whose max softmax is below 0.9 are 0, the rest keep their minProb 0 value", () => {
    const at0 = seedFromModel(model, tile, 0, [7, 8, 9]);
    const got = [...seedFromModel(model, tile, 0.9, [7, 8, 9])];
    const want = [...at0].map((v, i) => (v && maxProb(i) >= 0.9 ? v : 0));
    expect(got).toEqual(want);
    // both cases occur
    expect(want.filter((v) => v).length).toBeGreaterThan(0);
    expect([...at0].filter((v, i) => v && maxProb(i) < 0.9).length).toBeGreaterThan(0);
    // 1 keeps only certain pixels; none here
    expect([...seedFromModel(model, tile, 1, [7, 8, 9])].every((v, i) => v === 0 || maxProb(i) === 1)).toBe(true);
  });

  it("takes the first maximum on ties, as predictTile does", () => {
    const tie: Model = { ...model, W: [[0, 0], [0, 0], [0, 0]], b: [0, 0, 0] };
    expect([...seedFromModel(tie, tile, 0, [4, 5, 6])]).toEqual([4, 4, 4, 0, 0, 4]);
    expect([...seedFromModel(tie, tile, 0.34, [4, 5, 6])]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
