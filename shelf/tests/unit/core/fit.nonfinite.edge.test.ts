import { describe, expect, it } from "vitest";
import { fit } from "../../../src/core/fit";
import { EPS } from "../../../src/core/types";

// Tester: fit's non-finite check (issue 3b): band numbering on a band subset, first offender
// reported, and float32 extremes that are finite must still train to a finite model.

const finite = (m: ReturnType<typeof fit>) => [...m.W.flat(), ...m.b, ...m.mean, ...m.std].every(Number.isFinite);

describe("fit non-finite input (tester)", () => {
  it.each([Infinity, -Infinity, NaN])("names the 1-based raster band of a band subset for %d", (v) => {
    // bands [3, 5]: column 1 is raster band 5
    const X = new Float32Array([1, 2, 3, 4, 5, v, 7, 8]);
    expect(() => fit(X, new Uint8Array([0, 1, 0, 1]), [3, 5], ["a", "b"], { epochs: 1 })).toThrow("fit: sample 2 band 5 is not finite");
  });

  it("reports the first non-finite value in sample order", () => {
    const X = new Float32Array([1, Infinity, NaN, 4]);
    expect(() => fit(X, new Uint8Array([0, 1]), [1, 2], ["a", "b"])).toThrow("fit: sample 0 band 2 is not finite");
  });

  it("a non-finite value in the last sample, last band, is caught", () => {
    const X = new Float32Array([1, 2, 3, -Infinity]);
    expect(() => fit(X, new Uint8Array([0, 1]), [1, 2], ["a", "b"])).toThrow("fit: sample 1 band 2 is not finite");
  });

  it("float32 extremes (+-FLT_MAX) are finite and give a finite model that separates them", () => {
    const max = 3.4028234663852886e38;
    const X = new Float32Array([-max, -max, -max / 2, max, max / 2, max]);
    const m = fit(X, new Uint8Array([0, 0, 0, 1, 1, 1]), [1], ["a", "b"]);
    expect(finite(m)).toBe(true);
    expect(m.W[1]![0]! - m.W[0]![0]!).toBeGreaterThan(0);
  });

  it("a constant band at FLT_MAX gives std = EPS and a finite model", () => {
    const max = 3.4028234663852886e38;
    const n = 7;
    const X = new Float32Array(2 * n);
    const y = new Uint8Array(n);
    for (let i = 0; i < n; i++) { X[2 * i] = i < 3 ? 0 : 10; X[2 * i + 1] = max; y[i] = i < 3 ? 0 : 1; }
    const m = fit(X, y, [1, 2], ["a", "b"]);
    expect(m.std[1]).toBe(EPS);
    expect(finite(m)).toBe(true);
  });

  it("a constant band at an inexact value (0.1f, n = 3) gives std = EPS and a finite model", () => {
    const X = new Float32Array([0, 0.1, 0, 0.1, 10, 0.1]);
    const m = fit(X, new Uint8Array([0, 0, 1]), [1, 2], ["a", "b"]);
    expect(m.std[1]).toBe(EPS);
    expect(finite(m)).toBe(true);
  });
});
