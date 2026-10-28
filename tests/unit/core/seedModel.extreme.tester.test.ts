import { describe, expect, it } from "vitest";
import { predictTile, seedFromModel } from "../../../src/core/predict";
import type { Model, Tile } from "../../../src/core/types";

// Tester fuzz of F3 (spec 004 criterion 5): seedFromModel with infinite, huge and NaN-producing
// logits. Whatever the logits, the seed is values[predictTile] or 0, it equals values[predictTile]
// at minProb 0, the labelled set shrinks as minProb grows, the max softmax it uses is in [1/k, 1],
// and on finite logits it matches a log-sum-exp reference.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const EXTREME = [Infinity, -Infinity, 3.4e38, -3.4e38, 1e30, 0, -0];
const BIG_W = [0, 1e300, -1e300, 1e-300, 1, -1];

function extremeCase(seed: number): { model: Model; tile: Tile } {
  const r = rng(seed);
  const nb = 1 + Math.floor(r() * 3), k = 2 + Math.floor(r() * 4), n = 400;
  const bands = Array.from({ length: nb }, (_, i) => i + 1);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const model: Model = {
    version: 1, type: "logreg", bands, mean: bands.map(() => r() * 2), std: bands.map(() => 0.5 + r()),
    classes: Array.from({ length: k }, (_, i) => `k${i}`),
    W: Array.from({ length: k }, () => bands.map(() => (r() < 0.5 ? pick(BIG_W) : (r() - 0.5) * 8))),
    b: Array.from({ length: k }, () => (r() < 0.2 ? pick([1e308, -1e308, 0]) : (r() - 0.5) * 4)),
  };
  const tile: Tile = { x0: 0, y0: 0, width: n, height: 1, nodata: -1, bands: bands.map(() => Float32Array.from({ length: n }, () => {
    const u = r();
    return u < 0.03 ? -1 : u < 0.06 ? NaN : u < 0.4 ? pick(EXTREME) : (r() - 0.5) * 20;
  })) };
  return { model, tile };
}

/** Logits as predictTile's scan computes them, in float64. */
function logits(model: Model, tile: Tile, i: number): number[] {
  const z = model.bands.map((b, j) => (tile.bands[b - 1]![i]! - model.mean[j]!) / model.std[j]!);
  return model.W.map((w, c) => { let v = model.b[c]!; for (let j = 0; j < z.length; j++) v += w[j]! * z[j]!; return v; });
}

describe("seedFromModel on extreme logits (tester F3)", () => {
  const seeds = Array.from({ length: 60 }, (_, i) => 1000 + i);

  it("gives values[predictTile] or 0, exactly values[predictTile] at minProb 0, and 0 on nodata", () => {
    let infinite = 0, nan = 0;
    for (const seed of seeds) {
      const { model, tile } = extremeCase(seed);
      const pred = predictTile(model, tile);
      pred.forEach((p, i) => {
        if (p === 255) return;
        const l = logits(model, tile, i);
        if (l.some((x) => x === Infinity || x === -Infinity)) infinite++;
        if (l.some(Number.isNaN)) nan++;
      });
      const values = model.classes.map((_, i) => 250 - 3 * i);
      const at0 = seedFromModel(model, tile, 0, values);
      pred.forEach((p, i) => expect(at0[i], `seed ${seed} px ${i}`).toBe(p === 255 ? 0 : values[p]!));
      for (const q of [0.3, 0.5, 0.75, 0.99, 1]) {
        const s = seedFromModel(model, tile, q, values);
        s.forEach((v, i) => expect(v === 0 || v === values[pred[i]!], `seed ${seed} q ${q} px ${i}`).toBe(true));
      }
    }
    // the fuzz does reach infinite and NaN logits
    expect(infinite).toBeGreaterThan(1000);
    expect(nan).toBeGreaterThan(100);
  });

  it("labels fewer pixels as minProb grows, and every valid pixel just below 1/k", () => {
    for (const seed of seeds) {
      const { model, tile } = extremeCase(seed);
      const k = model.classes.length;
      const pred = predictTile(model, tile);
      const values = model.classes.map((_, i) => i + 1);
      const below = seedFromModel(model, tile, (1 / k) * (1 - 1e-9), values);
      pred.forEach((p, i) => expect(below[i] !== 0, `seed ${seed} px ${i}`).toBe(p !== 255));
      let prev = below;
      for (const q of [0.2, 0.4, 0.6, 0.8, 0.95, 1]) {
        const s = seedFromModel(model, tile, q, values);
        s.forEach((v, i) => { if (v) expect(prev[i], `seed ${seed} q ${q} px ${i}`).toBe(v); });
        prev = s;
      }
    }
  });

  it("on finite logits matches a log-sum-exp max softmax (away from the threshold)", () => {
    let checked = 0;
    for (const seed of seeds) {
      const { model, tile } = extremeCase(seed);
      const pred = predictTile(model, tile);
      const values = model.classes.map((_, i) => i + 1);
      for (const q of [0.5, 0.9]) {
        const s = seedFromModel(model, tile, q, values);
        for (let i = 0; i < pred.length; i++) {
          if (pred[i] === 255) continue;
          const l = logits(model, tile, i);
          if (!l.every(Number.isFinite)) continue;
          const top = Math.max(...l);
          const p = 1 / l.reduce((a, x) => a + Math.exp(x - top), 0);
          if (Math.abs(p - q) < 1e-9) continue;
          expect(s[i], `seed ${seed} q ${q} px ${i} p ${p}`).toBe(p >= q ? pred[i]! + 1 : 0);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});
