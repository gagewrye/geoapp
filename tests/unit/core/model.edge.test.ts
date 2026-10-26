import { describe, expect, it } from "vitest";
import { fit } from "../../../src/core/fit";
import { predictTile } from "../../../src/core/predict";
import { validate } from "../../../src/core/validate";
import { EPS, type Model } from "../../../src/core/types";
import { makeTile } from "../helpers/tiles";

// Edge cases for criteria 6, 7 and 11.

describe("fit edge cases (criterion 6)", () => {
  it("produces a model that validate accepts against the raster's band count", () => {
    const X = new Float32Array([1, 10, 2, 11, 8, 30, 9, 31]);
    const m = fit(X, new Uint8Array([0, 0, 1, 1]), [3, 1], ["a", "b"]);
    expect(() => validate(m, 3)).not.toThrow();
    expect(() => validate(m, 2)).toThrow(/bands/);
  });

  it("stays finite and valid when only one of the classes has samples", () => {
    const X = new Float32Array([1, 2, 3, 4, 5]);
    const m = fit(X, new Uint8Array(5), [1], ["only", "unused"]);
    expect(m.W.flat().concat(m.b, m.mean, m.std).every(Number.isFinite)).toBe(true);
    expect(() => validate(m, 1)).not.toThrow();
    expect([...predictTile(m, makeTile(0, 0, 5, 1, 1, (_k, c) => c + 1))]).toEqual([0, 0, 0, 0, 0]);
  });

  it("gives std = EPS for every band when all bands are constant, and finite W/b", () => {
    const n = 50;
    const X = new Float32Array(n * 2).fill(1e6 + 0.125);
    const y = Uint8Array.from({ length: n }, (_, i) => i % 2);
    const m = fit(X, y, [1, 2], ["a", "b"]);
    expect(m.std).toEqual([EPS, EPS]);
    expect(m.W.flat().concat(m.b).every(Number.isFinite)).toBe(true);
  });

  it("stays finite on large-magnitude separable inputs", () => {
    const n = 200;
    const X = Float32Array.from({ length: n }, (_, i) => (i < n / 2 ? -1e30 : 1e30) * (1 + (i % 7) * 1e-3));
    const y = Uint8Array.from({ length: n }, (_, i) => (i < n / 2 ? 0 : 1));
    const m = fit(X, y, [1], ["neg", "pos"]);
    expect(m.W.flat().concat(m.b, m.mean, m.std).every(Number.isFinite)).toBe(true);
    const tile = { x0: 0, y0: 0, width: n, height: 1, nodata: null, bands: [X] };
    const p = predictTile(m, tile);
    let ok = 0;
    for (let i = 0; i < n; i++) if (p[i] === y[i]) ok++;
    expect(ok / n).toBeGreaterThanOrEqual(0.95);
  });

  it("rejects X whose length does not match bands.length (band-count mismatch)", () => {
    expect(() => fit(new Float32Array(5), new Uint8Array(2), [1, 2], ["a", "b"])).toThrow();
  });
});

describe("predictTile edge cases (criterion 7)", () => {
  const base: Model = { version: 1, type: "logreg", bands: [1], mean: [0], std: [1], classes: ["a", "b"], W: [[-1], [1]], b: [0, 0] };

  it("writes 255 everywhere on an all-nodata tile, including NaN nodata", () => {
    expect([...predictTile(base, makeTile(0, 0, 3, 2, 1, () => -5, -5))]).toEqual([255, 255, 255, 255, 255, 255]);
    expect([...predictTile(base, makeTile(0, 0, 2, 1, 1, () => NaN, NaN))]).toEqual([255, 255]);
  });

  it("keeps class 254 distinct from nodata with 255 classes", () => {
    const classes = Array.from({ length: 255 }, (_, i) => `c${i}`);
    const m: Model = { ...base, classes, W: classes.map((_, i) => [i]), b: classes.map(() => 0) };
    expect(() => validate(m, 1)).not.toThrow();
    const out = predictTile(m, makeTile(0, 0, 3, 1, 1, (_k, c) => (c === 0 ? 1 : c === 1 ? -1 : NaN)));
    expect([...out]).toEqual([254, 0, 255]);
  });

  it("handles a partial edge tile (non-square, offset) the same as the matching slice of a full tile", () => {
    const f = (k: number, c: number, r: number) => Math.sin(c * 0.3 + r * 0.7 + k);
    const full = predictTile(base, makeTile(0, 0, 300, 260, 1, f));
    const edge = predictTile(base, makeTile(256, 256, 44, 4, 1, f));
    for (let r = 0; r < 4; r++) for (let c = 0; c < 44; c++) expect(edge[r * 44 + c]).toBe(full[(256 + r) * 300 + 256 + c]);
  });
});

describe("validate edge cases (criterion 11)", () => {
  const good = (): Model => ({ version: 1, type: "logreg", bands: [2], mean: [0], std: [1], classes: ["a", "b"], W: [[1], [2]], b: [0, 0] });
  type M = Record<string, unknown>;
  const mutate = (f: (m: M) => void) => { const m = good() as unknown as M; f(m); return m; };

  it("accepts exactly 2 and exactly 255 classes, and a single-band subset", () => {
    expect(() => validate(good(), 5)).not.toThrow();
    const classes = Array.from({ length: 255 }, (_, i) => `c${i}`);
    expect(() => validate({ ...good(), classes, W: classes.map(() => [0]), b: classes.map(() => 0) }, 2)).not.toThrow();
  });

  const cases: [string, RegExp, (m: M) => void][] = [
    ["type missing", /type/, (m) => { delete m.type; }],
    ["version string", /version/, (m) => { m.version = "1"; }],
    ["band index NaN", /bands/, (m) => { m.bands = [NaN]; }],
    ["band index Infinity", /bands/, (m) => { m.bands = [Infinity]; }],
    ["band index string", /bands/, (m) => { m.bands = ["2"]; }],
    ["negative band index", /bands/, (m) => { m.bands = [-1]; }],
    ["band above count by one", /bands/, (m) => { m.bands = [6]; }],
    ["std Infinity", /std/, (m) => { m.std = [Infinity]; }],
    ["std NaN", /std/, (m) => { m.std = [NaN]; }],
    ["mean NaN", /mean/, (m) => { m.mean = [NaN]; }],
    ["W missing", /W/, (m) => { delete m.W; }],
    ["b missing", /\bb\b/, (m) => { delete m.b; }],
    ["mean missing", /mean/, (m) => { delete m.mean; }],
    ["classes missing", /classes/, (m) => { delete m.classes; }],
    ["W row not an array", /W/, (m) => { m.W = [1, 2]; }],
    ["b -Infinity", /\bb\b/, (m) => { m.b = [0, -Infinity]; }],
    ["zero classes", /classes/, (m) => { m.classes = []; m.W = []; m.b = []; }],
  ];
  for (const [name, re, f] of cases) {
    it(`rejects ${name}`, () => expect(() => validate(mutate(f), 5)).toThrow(re));
  }
});
