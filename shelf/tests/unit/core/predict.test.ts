import { describe, expect, it } from "vitest";
import { predictTile } from "../../../src/core/predict";
import type { Model, Tile } from "../../../src/core/types";

// Hand-computed reference: z = ((x1-10)/2, (x2-20)/4); logits = W z + b.
const model: Model = { version: 1, type: "logreg", bands: [1, 2], mean: [10, 20], std: [2, 4],
  classes: ["a", "b", "c"], W: [[1, 0], [0, 1], [-1, -1]], b: [0, 0, 0.5] };
const tile: Tile = { x0: 256, y0: 0, width: 3, height: 2, nodata: -9, bands: [
  new Float32Array([14, 10, 6, -9, NaN, 12]),
  new Float32Array([20, 32, 12, 20, 20, 28]),
  new Float32Array([-9, -9, -9, -9, -9, -9]),
] };

describe("predictTile (criterion 7)", () => {
  it("matches the precomputed reference, with 255 at nodata", () => {
    expect([...predictTile(model, tile)]).toEqual([0, 1, 2, 255, 255, 1]);
  });
  it("uses only model bands, in model order, for values and nodata", () => {
    const m: Model = { ...model, bands: [2, 1], mean: [20, 10], std: [4, 2], W: [[0, 1], [1, 0], [-1, -1]] };
    expect([...predictTile(m, tile)]).toEqual([0, 1, 2, 255, 255, 1]);
    const t: Tile = { ...tile, bands: [tile.bands[0]!, tile.bands[1]!, new Float32Array([0, 0, 0, 0, 0, NaN])] };
    expect(predictTile(model, t)[5]).toBe(1);
  });
});
