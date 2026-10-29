import { describe, expect, it } from "vitest";
import { validate } from "../../../src/core/validate";
import type { Model } from "../../../src/core/types";

const good = (): Model => ({ version: 1, type: "logreg", bands: [4, 2], mean: [1, 2], std: [0.5, 1e-6],
  classes: ["a", "b", "c"], W: [[1, 2], [3, 4], [5, 6]], b: [0, 1, 2] });
type M = Record<string, unknown> & Model;
const bad = (mut: (m: M) => void) => { const m = good() as M; mut(m); return m; };

describe("validate (criterion 11)", () => {
  it("accepts a valid model using a subset of bands", () => {
    expect(() => validate(good(), 4)).not.toThrow();
  });
  const cases: [string, RegExp, (m: M) => void][] = [
    ["version 2", /version/, (m) => { m.version = 2 as 1; }],
    ["type", /type/, (m) => { m.type = "rf" as "logreg"; }],
    ["non-integer band", /bands/, (m) => { m.bands[0] = 1.5; }],
    ["band 0", /bands/, (m) => { m.bands[0] = 0; }],
    ["band above count", /bands/, (m) => { m.bands[0] = 5; }],
    ["duplicate band", /bands/, (m) => { m.bands[1] = 4; }],
    ["mean length", /mean/, (m) => { m.mean.push(0); }],
    ["std length", /std/, (m) => { m.std.pop(); }],
    ["W row length", /W\[1\]/, (m) => { m.W[1]!.push(0); }],
    ["W length", /W/, (m) => { m.W.pop(); }],
    ["b length", /\bb\b/, (m) => { m.b.push(0); }],
    ["one class", /classes/, (m) => { m.classes = ["a"]; m.W = [[1, 2]]; m.b = [0]; }],
    ["256 classes", /classes/, (m) => { m.classes = Array.from({ length: 256 }, (_, i) => `c${i}`); m.W = m.classes.map(() => [0, 0]); m.b = m.classes.map(() => 0); }],
    ["std zero", /std/, (m) => { m.std[0] = 0; }],
    ["std negative", /std/, (m) => { m.std[1] = -1; }],
    ["NaN in W", /W/, (m) => { m.W[2]![0] = NaN; }],
    ["Infinity in b", /\bb\b/, (m) => { m.b[0] = Infinity; }],
    ["Infinity in mean", /mean/, (m) => { m.mean[0] = -Infinity; }],
    ["non-number in W", /W/, (m) => { (m.W[0] as unknown[])[0] = "1"; }],
    ["non-string class", /classes/, (m) => { (m.classes as unknown[])[0] = 3; }],
  ];
  for (const [name, re, mut] of cases) {
    it(`rejects ${name}`, () => expect(() => validate(bad(mut), 4)).toThrow(re));
  }
  it("rejects non-objects", () => {
    expect(() => validate(null, 4)).toThrow(/model/);
    expect(() => validate([], 4)).toThrow(/model/);
  });
});
