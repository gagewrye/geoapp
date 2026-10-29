import { describe, expect, it } from "vitest";
import { fit } from "../../../src/core/fit";
import { parseModel, serializeModel } from "../../../src/core/modelio";
import { predictTile } from "../../../src/core/predict";
import { makeTile } from "../helpers/tiles";

describe("model JSON (criterion 10)", () => {
  it("round-trips with identical predictions", () => {
    const X = new Float32Array([0.1, 3.3, 0.2, 2.9, 5.5, 0.4, 6.1, 0.2, 2.5, 2.5, 0.3, 3.1]);
    const y = new Uint8Array([0, 0, 1, 1, 0, 0]);
    const model = fit(X, y, [2, 3], ["bare", "veg"], { epochs: 50 });
    const loaded = parseModel(serializeModel(model), 3);
    expect(loaded).toEqual(model);
    const tile = makeTile(0, 0, 16, 16, 3, (k, c, r) => Math.sin(k * 7 + c * 0.37 + r * 0.11) * 4);
    expect(predictTile(loaded, tile)).toEqual(predictTile(model, tile));
  });
  it("rejects invalid JSON and invalid models", () => {
    expect(() => parseModel("{", 3)).toThrow(/JSON/);
    expect(() => parseModel(JSON.stringify({ version: 1 }), 3)).toThrow(/type/);
  });
});
