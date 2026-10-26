import { describe, expect, it } from "vitest";
import { fit } from "../../../src/core/fit";
import { predictTile } from "../../../src/core/predict";
import { EPS } from "../../../src/core/types";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Three linearly separable clusters in bands 1-2; band 3 constant. */
function synthetic(n: number) {
  const rnd = lcg(42);
  const centres = [[0, 0], [5, 0], [0, 5]];
  const X = new Float32Array(n * 3);
  const y = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = i % 3;
    X[3 * i] = 100 + 10 * (centres[k]![0]! + (rnd() - 0.5) * 3);
    X[3 * i + 1] = -50 + 10 * (centres[k]![1]! + (rnd() - 0.5) * 3);
    X[3 * i + 2] = 7;
    y[i] = k;
  }
  return { X, y };
}

describe("fit (criterion 6)", () => {
  const { X, y } = synthetic(600);
  const model = fit(X, y, [1, 2, 4], ["water", "forest", "urban"]);

  it("reaches at least 95% train accuracy on a separable set", () => {
    const n = y.length;
    const bands = [0, 1, 2, 3].map((k) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = k === 3 ? X[3 * i + 2]! : k === 2 ? 0 : X[3 * i + k]!;
      return a;
    });
    const pred = predictTile(model, { x0: 0, y0: 0, width: n, height: 1, bands, nodata: null });
    let ok = 0;
    for (let i = 0; i < n; i++) if (pred[i] === y[i]) ok++;
    expect(ok / n).toBeGreaterThanOrEqual(0.95);
  });
  it("stores std = EPS for a constant band and finite W/b", () => {
    expect(model.std[2]).toBe(EPS);
    expect(model.mean[2]).toBeCloseTo(7, 5);
    expect(model.W.flat().concat(model.b).every(Number.isFinite)).toBe(true);
    expect(model).toMatchObject({ version: 1, type: "logreg", bands: [1, 2, 4], classes: ["water", "forest", "urban"] });
    expect(model.W).toHaveLength(3);
    expect(model.W[0]).toHaveLength(3);
  });
  it("rejects empty input and out-of-range labels", () => {
    expect(() => fit(new Float32Array(0), new Uint8Array(0), [1], ["a", "b"])).toThrow(/sample/);
    expect(() => fit(new Float32Array([1, 2]), new Uint8Array([0, 2]), [1], ["a", "b"])).toThrow(/label/);
  });
  it("rejects fewer than 2 or more than 255 classes", () => {
    const cls = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
    expect(() => fit(new Float32Array([1]), new Uint8Array([0]), [1], cls(1))).toThrow(/2\.\.255 classes/);
    expect(() => fit(new Float32Array([1, 2]), new Uint8Array([0, 1]), [1], cls(256))).toThrow(/2\.\.255 classes/);
    expect(() => fit(new Float32Array([1, 2]), new Uint8Array([0, 1]), [1], cls(255), { epochs: 1 })).not.toThrow();
  });
});
