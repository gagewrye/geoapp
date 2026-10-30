import { describe, expect, it } from "vitest";
import { alphaOf, displaySamples, maskSamples } from "../../../src/core/alpha";
import { nodataMask, maskBit } from "../../../src/core/nodata";
import { maskNodata, nodataPossible } from "../../../src/core/seed";
import { toRgba } from "../../../src/core/imagery";
import { warpPreview } from "../../../src/core/warp";
import type { Tile } from "../../../src/core/types";

// Spec 022 criteria 1 (alphaOf), 3 (toRgba), 5 (nodataMask, maskNodata), and the band choices behind 4, 7 and 8.

describe("alphaOf (criterion 1)", () => {
  it.each([
    [[2], 4, 3], [[1], 4, 3], [[0], 4, null], [[], 3, null], [[2], 2, 1], [[0, 2], 5, 4],
  ] as const)("ExtraSamples %j of %i samples -> %s", (extra, spp, want) => {
    expect(alphaOf([...extra], spp)).toBe(want);
  });
});

describe("which samples are read", () => {
  it("displays [0, 1, 2, alpha] or [0, alpha], else bands 1-3 or band 1", () => {
    expect(displaySamples(4, 3)).toEqual([0, 1, 2, 3]);
    expect(displaySamples(2, 1)).toEqual([0, 1]);
    expect(displaySamples(5, 4)).toEqual([0, 1, 2, 4]);
    expect(displaySamples(3, null)).toEqual([0, 1, 2]);
    expect(displaySamples(4, null)).toEqual([0, 1, 2]);
    expect(displaySamples(1, null)).toEqual([0]);
  });

  it("masks from the alpha sample alone when there is no nodata and samples are integer (criterion 8), else from every band", () => {
    expect(maskSamples(4, null, false, 3)).toEqual({ samples: [3], alpha: 0 });
    expect(maskSamples(4, 0, false, 3)).toEqual({ samples: [0, 1, 2, 3], alpha: 3 });
    expect(maskSamples(4, null, true, 3)).toEqual({ samples: [0, 1, 2, 3], alpha: 3 });
    expect(maskSamples(3, 5, false, null)).toEqual({ samples: [0, 1, 2], alpha: null });
  });

  it("nodataPossible counts an alpha band (spec 021's skip, amended)", () => {
    expect(nodataPossible(null, false, true)).toBe(true);
    expect(nodataPossible(null, false, false)).toBe(false);
    expect(nodataPossible(null, false)).toBe(false);
  });
});

const rgbaTile = (alphas: number[], alpha: number | null = 3): Tile => {
  const n = alphas.length;
  const bands = [new Float32Array(n).fill(50), new Float32Array(n).fill(60), new Float32Array(n).fill(70), Float32Array.from(alphas)];
  return { x0: 0, y0: 0, width: n, height: 1, bands, nodata: null, alpha };
};

describe("toRgba with alpha (criterion 3)", () => {
  const ranges: [number, number][] = [[0, 100], [0, 100], [0, 100]];
  it("alpha 0 gives [0, 0, 0, 0] whatever the RGB; 1, 128, 255 and 65535 give alpha 255", () => {
    const t = rgbaTile([0, 1, 128, 255, 65535]);
    const out = new Uint8ClampedArray(4 * 5);
    toRgba(t.bands, 5, ranges, null, out, 3);
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    for (let p = 1; p < 5; p++) expect([...out.subarray(4 * p, 4 * p + 4)]).toEqual([...Uint8ClampedArray.from([50 / 100 * 255, 60 / 100 * 255, 70 / 100 * 255, 255])]);
  });

  it("gray plus alpha uses band 0 for grey", () => {
    const out = new Uint8ClampedArray(8);
    toRgba([Float32Array.from([50, 50]), Float32Array.from([0, 9])], 2, [[0, 100]], null, out, 1);
    expect([...out]).toEqual([0, 0, 0, 0, 128, 128, 128, 255]);
  });

  it("without alpha the output is byte-equal to the call without the argument", () => {
    const bands = [Float32Array.from([0, 30, NaN, 9]), Float32Array.from([5, 60, 1, 9]), Float32Array.from([7, 90, 2, 9])];
    const a = new Uint8ClampedArray(16), b = new Uint8ClampedArray(16), c = new Uint8ClampedArray(16);
    toRgba(bands, 4, ranges, 9, a);
    toRgba(bands, 4, ranges, 9, b, null);
    toRgba([...bands, Float32Array.from([0, 0, 0, 0])], 4, ranges, 9, c); // a 4th band that isn't alpha is ignored as before
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect([...a.subarray(4, 8)]).toEqual([...Uint8ClampedArray.from([30 / 100 * 255, 60 / 100 * 255, 90 / 100 * 255, 255])]);
  });
});

describe("warpPreview with alpha (criterion 4, core)", () => {
  it("skips alpha-0 pixels in the ranges and draws them transparent", () => {
    // 4 x 1 px: two transparent black pixels, two visible at 100 and 200
    const t: Tile = { x0: 0, y0: 0, width: 4, height: 1, nodata: null, alpha: 3,
      bands: [0, 1, 2].map(() => Float32Array.from([0, 100, 0, 200])).concat([Float32Array.from([0, 255, 0, 255])]) };
    const p = warpPreview(t, [500000, 10, 0, 5000000, 0, -10], 32633, 4);
    expect(p.ranges).toEqual([[100, 200], [100, 200], [100, 200]]);
    const alphas = Array.from({ length: p.width * p.height }, (_, i) => p.rgba[4 * i + 3]);
    expect(alphas.filter((a) => a === 0).length).toBeGreaterThan(0);
    expect(alphas.filter((a) => a === 255).length).toBeGreaterThan(0);
  });
});

describe("nodataMask and maskNodata with alpha (criterion 5)", () => {
  it("mask alpha 0 and not alpha 1", () => {
    const t = rgbaTile([0, 1, 0, 255]);
    const m = nodataMask(t);
    expect([0, 1, 2, 3].map((i) => maskBit(m, i))).toEqual([1, 0, 1, 0]);
    const labels = Uint8Array.from([4, 4, 4, 4]);
    maskNodata(t, labels);
    expect([...labels]).toEqual([0, 4, 0, 4]);
  });

  it("with no alpha their results are unchanged: a 0 in band 4 isn't nodata", () => {
    for (const alpha of [null, undefined]) {
      const t = { ...rgbaTile([0, 1, 0, 255], null), alpha };
      expect([0, 1, 2, 3].map((i) => maskBit(nodataMask(t), i))).toEqual([0, 0, 0, 0]);
      const labels = Uint8Array.from([4, 4, 4, 4]);
      maskNodata(t, labels);
      expect([...labels]).toEqual([4, 4, 4, 4]);
    }
  });
});
