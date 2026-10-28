import { describe, expect, it } from "vitest";
import { predictTile, seedFromModel } from "../../../src/core/predict";
import type { Model, Tile } from "../../../src/core/types";

// Tester checks of spec 004 criterion 5 beyond its fixed tile: random models and tiles, ties,
// minProb 1, and an independent softmax at the threshold.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function randomCase(seed: number): { model: Model; tile: Tile } {
  const r = rng(seed);
  const nb = 1 + Math.floor(r() * 4), k = 2 + Math.floor(r() * 5), n = 300;
  const bands = Array.from({ length: nb }, (_, i) => i + 1).filter(() => r() < 0.8);
  if (!bands.length) bands.push(1);
  const model: Model = {
    version: 1, type: "logreg", bands, mean: bands.map(() => r() * 10), std: bands.map(() => 0.5 + r() * 3),
    classes: Array.from({ length: k }, (_, i) => `k${i}`),
    W: Array.from({ length: k }, () => bands.map(() => (r() - 0.5) * 6)), b: Array.from({ length: k }, () => (r() - 0.5) * 2),
  };
  const tile: Tile = { x0: 0, y0: 0, width: n, height: 1, nodata: -1, bands: Array.from({ length: nb }, () => Float32Array.from({ length: n }, () => {
    const u = r();
    return u < 0.05 ? -1 : u < 0.08 ? NaN : r() * 20;
  })) };
  return { model, tile };
}

/** Max softmax per pixel by the textbook formula exp(l_max) / sum(exp(l)), in float64. */
function maxSoftmax(model: Model, tile: Tile, i: number): number {
  const z = model.bands.map((b, j) => (tile.bands[b - 1]![i]! - model.mean[j]!) / model.std[j]!);
  const l = model.W.map((w, c) => model.b[c]! + w.reduce((s, wj, j) => s + wj * z[j]!, 0));
  const e = l.map(Math.exp);
  return Math.max(...e) / e.reduce((s, x) => s + x, 0);
}

describe("seedFromModel on random models and tiles", () => {
  it("at minProb 0 equals predictTile + 1 (255 -> 0), and with any values maps through values[predictTile]", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { model, tile } = randomCase(seed);
      const pred = [...predictTile(model, tile)];
      expect([...seedFromModel(model, tile, 0, model.classes.map((_, i) => i + 1))], `seed ${seed}`).toEqual(pred.map((p) => (p === 255 ? 0 : p + 1)));
      const values = model.classes.map((_, i) => 200 - 7 * i);
      expect([...seedFromModel(model, tile, 0, values)]).toEqual(pred.map((p) => (p === 255 ? 0 : values[p]!)));
    }
  });

  it("at 0.3, 0.6 and 0.9 labels exactly the pixels whose max softmax is at least the threshold (away from float ties)", () => {
    let below = 0, above = 0;
    for (let seed = 100; seed < 120; seed++) {
      const { model, tile } = randomCase(seed);
      const pred = predictTile(model, tile);
      for (const p of [0.3, 0.6, 0.9]) {
        const got = seedFromModel(model, tile, p, model.classes.map((_, i) => i + 1));
        for (let i = 0; i < got.length; i++) {
          if (pred[i] === 255) { expect(got[i]).toBe(0); continue; }
          const m = maxSoftmax(model, tile, i);
          if (Math.abs(m - p) < 1e-9) continue;
          expect(got[i], `seed ${seed} p ${p} px ${i} softmax ${m}`).toBe(m >= p ? pred[i]! + 1 : 0);
          if (m >= p) above++; else below++;
        }
      }
    }
    expect(below).toBeGreaterThan(100);
    expect(above).toBeGreaterThan(100);
  });

  it("ties take the first maximum, as predictTile does", () => {
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b", "c"], W: [[0], [0], [0]], b: [0, 0, 0] };
    const tile: Tile = { x0: 0, y0: 0, width: 2, height: 1, nodata: null, bands: [new Float32Array([3, -3])] };
    expect([...seedFromModel(model, tile, 0, [7, 8, 9])]).toEqual([7, 7]);
    // max softmax is 1/3: labelled at 1/3, not above it
    expect([...seedFromModel(model, tile, 1 / 3, [7, 8, 9])]).toEqual([7, 7]);
    expect([...seedFromModel(model, tile, 0.34, [7, 8, 9])]).toEqual([0, 0]);
  });

  it("at minProb 1 labels only pixels whose other classes underflow to probability 0", () => {
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b"], W: [[1], [-1]], b: [0, 0] };
    const tile: Tile = { x0: 0, y0: 0, width: 3, height: 1, nodata: null, bands: [new Float32Array([1, 400, -400])] };
    expect([...seedFromModel(model, tile, 1, [1, 2])]).toEqual([0, 1, 2]);
  });

  // Tester F3: a valid (non-nodata, non-NaN) Float32 pixel of +Infinity makes the logits infinite;
  // criterion 5's "at minProb 0 it equals predictTile + 1" must hold there too.
  it("at minProb 0 equals predictTile + 1 on a pixel of +Infinity", () => {
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b"], W: [[1], [-1]], b: [0, 0] };
    const tile: Tile = { x0: 0, y0: 0, width: 2, height: 1, nodata: null, bands: [new Float32Array([Infinity, 1])] };
    const pred = [...predictTile(model, tile)];
    expect(pred).toEqual([0, 0]);
    expect([...seedFromModel(model, tile, 0, [1, 2])]).toEqual([1, 1]);
  });

  it("with infinite logits the single top class has probability 1, tied ones share it, and 0 * Infinity logits count for nothing", () => {
    const tile: Tile = { x0: 0, y0: 0, width: 3, height: 1, nodata: null, bands: [new Float32Array([Infinity, -Infinity, 1])] };
    const one: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b"], W: [[1], [-1]], b: [0, 0] };
    // +Infinity: class a alone at +Infinity; -Infinity: class b alone
    expect([...predictTile(one, tile)].slice(0, 2)).toEqual([0, 1]);
    expect([...seedFromModel(one, tile, 1, [1, 2])].slice(0, 2)).toEqual([1, 2]);
    // both logits +Infinity (or both -Infinity): a tie at 1/2, the first maximum as in predictTile
    const tie: Model = { ...one, W: [[1], [1]] };
    expect([...predictTile(tie, tile)].slice(0, 2)).toEqual([0, 0]);
    expect([...seedFromModel(tie, tile, 0.5, [1, 2])].slice(0, 2)).toEqual([1, 1]);
    expect([...seedFromModel(tie, tile, 0.51, [1, 2])].slice(0, 2)).toEqual([0, 0]);
    // a zero weight on an infinite pixel gives a NaN logit, which predictTile never picks: b wins with probability 1
    const zero: Model = { ...one, classes: ["a", "b", "c"], W: [[0], [1], [-1]], b: [0, 0, 0] };
    expect([...predictTile(zero, tile)]).toEqual([1, 2, 1]);
    expect([...seedFromModel(zero, tile, 1, [1, 2, 3])].slice(0, 2)).toEqual([2, 3]);
    expect([...seedFromModel(zero, tile, 0, [1, 2, 3])]).toEqual([2, 3, 2]);
  });

  it("at minProb 0 labels a pixel whose logits are all NaN with predictTile's class", () => {
    const model: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b"], W: [[0], [0]], b: [0, 0] };
    const tile: Tile = { x0: 0, y0: 0, width: 1, height: 1, nodata: null, bands: [new Float32Array([Infinity])] };
    expect([...predictTile(model, tile)]).toEqual([0]);
    expect([...seedFromModel(model, tile, 0, [1, 2])]).toEqual([1]);
    expect([...seedFromModel(model, tile, 0.5, [1, 2])]).toEqual([1]); // nothing known: uniform, 1/2
    expect([...seedFromModel(model, tile, 0.6, [1, 2])]).toEqual([0]);
  });
});
