import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import { chooseMask, decodeLog, maskBits, maskShare, maskSpans, promptPoints, SAM_SIDE, samInput, samWindow, stability } from "../../../src/core/smart";

// Spec 046 criteria 1 and 2.
describe("samWindow (criterion 1)", () => {
  for (const [width, height] of [[300, 300], [1024, 1024], [3000, 2000]] as const) {
    it(`every cell of ${width}x${height} lies inside its window, which lies in the raster, 384 px from inner edges`, () => {
      const step = width > 1024 ? 7 : 1; // brute force, thinned on the large raster to keep the test quick
      for (let row = 0; row < height; row += step) for (let col = 0; col < width; col += step) {
        const w = samWindow({ width, height }, col, row);
        const ok = w.width === Math.min(SAM_SIDE, width) && w.height === Math.min(SAM_SIDE, height)
          && col >= w.x0 && col < w.x0 + w.width && row >= w.y0 && row < w.y0 + w.height
          && w.x0 >= 0 && w.y0 >= 0 && w.x0 + w.width <= width && w.y0 + w.height <= height
          && (w.x0 === 0 || col - w.x0 >= 384) && (w.y0 === 0 || row - w.y0 >= 384)
          && (w.x0 + w.width === width || w.x0 + w.width - col >= 384) && (w.y0 + w.height === height || w.y0 + w.height - row >= 384);
        if (!ok) expect({ col, row, w }).toBe("a valid window");
      }
    });
  }

  it("snaps to 256 px steps", () => {
    expect(samWindow({ width: 3000, height: 2000 }, 1500, 1000)).toEqual({ x0: 1024, y0: 512, width: 1024, height: 1024 });
  });
});

describe("samInput (criterion 1)", () => {
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  const w = 3, h = 2, rgba = new Uint8ClampedArray(4 * w * h);
  rgba.set([10, 128, 250, 255], 4 * (1 * w + 2)); // pixel (2, 1)
  rgba.set([200, 200, 200, 0], 4 * (0 * w + 1)); // pixel (1, 0): alpha 0
  const t = samInput(rgba, w, h);
  const at = (c: number, x: number, y: number) => t[c * SAM_SIDE * SAM_SIDE + y * SAM_SIDE + x]!;

  it("has length 3 x 1024^2", () => expect(t.length).toBe(3 * 1024 * 1024));
  it("normalises a pixel with ImageNet mean and std", () => {
    [10, 128, 250].forEach((v, c) => expect(at(c, 2, 1)).toBeCloseTo((v / 255 - MEAN[c]!) / STD[c]!, 6));
  });
  it("gives 0 at an alpha-0 pixel and in padding", () => {
    for (let c = 0; c < 3; c++) {
      expect(at(c, 1, 0)).toBe(0);
      expect(at(c, 3, 0)).toBe(0);
      expect(at(c, 0, 2)).toBe(0);
      expect(at(c, 1023, 1023)).toBe(0);
    }
  });
});

describe("promptPoints (criterion 1)", () => {
  it("maps a window's corner cell to (0.5, 0.5)", () => {
    const w: Window = { x0: 512, y0: 768, width: 1024, height: 1024 };
    expect([...promptPoints([[512, 768], [600, 800]], w)]).toEqual([0.5, 0.5, 88.5, 32.5]);
  });
});

/** Brute-force bilinear (half-pixel centres, edges clamped) of side^2 logits over SAM_SIDE^2, at each window pixel's centre. */
function reference(logits: Float32Array, side: number, w: Window): Uint8Array {
  const out = new Uint8Array(w.width * w.height), s = side / SAM_SIDE;
  const v = (x: number, y: number) => logits[y * side + x]!;
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) {
    const u = Math.max(0, (x + 0.5) * s - 0.5), t = Math.max(0, (y + 0.5) * s - 0.5);
    const x0 = Math.min(Math.floor(u), side - 1), y0 = Math.min(Math.floor(t), side - 1);
    const x1 = Math.min(x0 + 1, side - 1), y1 = Math.min(y0 + 1, side - 1), fx = u - x0, fy = t - y0;
    const top = (1 - fx) * v(x0, y0) + fx * v(x1, y0), bottom = (1 - fx) * v(x0, y1) + fx * v(x1, y1);
    out[y * w.width + x] = (1 - fy) * top + fy * bottom > 0 ? 1 : 0;
  }
  return out;
}

describe("maskBits and maskSpans (criterion 2)", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const logits = Float32Array.from({ length: 256 * 256 }, rand);

  for (const w of [{ x0: 2048, y0: 512, width: 1024, height: 1024 }, { x0: 0, y0: 0, width: 300, height: 200 }]) {
    it(`equals a brute-force bilinear reference for a ${w.width}x${w.height} window`, () => {
      const bits = maskBits(logits, 256, w);
      expect(bits.length).toBe(w.width * w.height);
      expect(bits.some((b) => b === 1) && bits.some((b) => b === 0)).toBe(true);
      const ref = reference(logits, 256, w);
      expect(bits.every((b, i) => b === ref[i])).toBe(true);
    });

    it(`maskSpans covers exactly the 1-bits of a ${w.width}x${w.height} window, in raster coordinates`, () => {
      const bits = maskBits(logits, 256, w), seen = new Uint8Array(bits.length);
      for (const s of maskSpans(bits, w)) {
        expect(s.x1).toBeGreaterThan(s.x0);
        for (let x = s.x0; x < s.x1; x++) {
          const i = (s.row - w.y0) * w.width + (x - w.x0);
          expect(seen[i]).toBe(0);
          seen[i] = 1;
        }
      }
      expect([...seen]).toEqual([...bits]);
    });
  }

});

// Amendment A, criteria 12-14 (A2's padPrompt isn't built: the export pads internally).
describe("stability and maskShare (criterion 12)", () => {
  const logits = Float32Array.from([2, 0.5, -0.5, -2]);
  it("stability is the share of logits > 1 among those > -1", () => {
    expect(stability(logits)).toBeCloseTo(1 / 3, 12);
    expect(stability(Float32Array.from([-1, -2, -5]))).toBe(0);
  });
  it("maskShare is the share of logits > 0", () => expect(maskShare(logits)).toBe(0.5));
});

describe("chooseMask (criterion 13)", () => {
  const scores = Float32Array.from([0.96, 0.91, 0.8]);
  it("takes the highest IoU among stable masks", () => expect(chooseMask(scores, [0.68, 0.95, 0.97])).toBe(1));
  it("takes the most stable when none is stable", () => expect(chooseMask(scores, [0.5, 0.7, 0.6])).toBe(1));
  it("breaks ties to the lower index", () => {
    expect(chooseMask(Float32Array.from([0.9, 0.9, 0.9]), [0.95, 0.95, 0.95])).toBe(0);
    expect(chooseMask(Float32Array.from([0.5, 0.9, 0.9]), [0.5, 0.7, 0.7])).toBe(1);
  });
});

describe("decodeLog (criterion 14)", () => {
  it("writes one line per decode, marking the chosen mask", () => {
    expect(decodeLog(2, Float32Array.from([0.96, 0.91, 0.8]), [0.68, 0.95, 0.97], [0.523, 0.06, 0.004], 1))
      .toBe("smart: 2 pts | #0 iou 0.96 stab 0.68 area 52% | #1 iou 0.91 stab 0.95 area 6% * | #2 iou 0.80 stab 0.97 area 0%");
  });
});
