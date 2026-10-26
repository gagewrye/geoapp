import { describe, expect, it } from "vitest";
import { AEF_PREVIEW_NODATA, aefPreview, dequantize } from "../../../src/core/aef";
import type { Tile } from "../../../src/core/types";

describe("dequantize (criterion 1)", () => {
  it("maps q to sign(q)(q/127.5)^2 and -128 to NaN", () => {
    const q = Int8Array.from([-127, -1, 0, 1, 127, -128]);
    const out = new Float32Array(q.length);
    dequantize(q, out);
    for (let i = 0; i < 5; i++) {
      const v = q[i]!;
      expect(Math.abs(out[i]! - Math.sign(v) * (v / 127.5) ** 2)).toBeLessThan(1e-7);
    }
    expect(out[5]).toBeNaN();
  });

  it("rejects mismatched lengths", () => {
    expect(() => dequantize(new Int8Array(2), new Float32Array(3))).toThrow();
  });
});

describe("aefPreview (criterion 5)", () => {
  const tile = (vals: number[]): Tile => ({
    x0: 3, y0: 4, width: vals.length, height: 1, nodata: null,
    bands: Array.from({ length: 64 }, (_, k) => Float32Array.from(vals, (v) => (k === 1 || k === 16 || k === 9 ? v : 99))),
  });

  it("stretches A01, A16, A09 linearly from [-0.3, 0.3] to [0, 255], clamped, NaN to nodata", () => {
    const out = aefPreview(tile([-0.3, 0, 0.3, 0.9, -0.9, NaN]));
    expect(out.bands).toHaveLength(3);
    expect([out.x0, out.y0, out.width, out.height]).toEqual([3, 4, 6, 1]);
    for (const b of out.bands) expect(Array.from(b)).toEqual([0, 128, 255, 255, 0, AEF_PREVIEW_NODATA]);
    expect(out.nodata).toBe(AEF_PREVIEW_NODATA);
  });

  it("takes band 2 as red, band 17 as green, band 10 as blue", () => {
    const t = tile([0]);
    t.bands[1]![0] = -0.3; t.bands[16]![0] = 0; t.bands[9]![0] = 0.3;
    expect(aefPreview(t).bands.map((b) => b[0])).toEqual([0, 128, 255]);
  });
});
