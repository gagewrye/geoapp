import { describe, expect, it } from "vitest";
import { labelSamples } from "../../../src/core/labelSamples";
import { brush, emptyStore, labelWindows, tileKeys } from "../../../src/core/labelStore";
import { makeTile } from "../helpers/tiles";

const id = (k: number, c: number, r: number) => (k === 0 ? c * 10000 + r : k + 0.5); // band 1 unique per pixel

describe("labelSamples (criterion 5)", () => {
  it("gives y = value - 1 and skips 0, nodata and NaN", () => {
    const t = makeTile(0, 0, 4, 2, 2, (k, c, r) => (k === 1 && c === 2 && r === 0 ? -1 : k === 0 && c === 3 && r === 1 ? NaN : id(k, c, r)), -1);
    const labels = Uint8Array.from([1, 0, 3, 2, 255, 1, 0, 2]);
    const s = labelSamples(t, labels, [1, 2]);
    // pixel 2 is nodata in band 2; pixel 7 is NaN in band 1
    expect([...s.y]).toEqual([0, 1, 254, 0]);
    expect([...s.X]).toEqual([0, 1.5, 30000, 1.5, 1, 1.5, 10001, 1.5]);
  });

  it("applies the nodata rule to the bands given only", () => {
    const t = makeTile(0, 0, 2, 1, 2, (k, c) => (k === 1 && c === 0 ? -1 : c), -1);
    expect(labelSamples(t, Uint8Array.from([1, 1]), [1]).y).toHaveLength(2);
    expect(labelSamples(t, Uint8Array.from([1, 1]), [1, 2]).y).toHaveLength(1);
  });

  it("selects bands in the given order", () => {
    const t = makeTile(0, 0, 2, 1, 3, (k, c) => 10 * k + c);
    expect([...labelSamples(t, Uint8Array.from([0, 4]), [3, 1]).X]).toEqual([21, 1]);
  });

  it("returns empty typed arrays when nothing is labelled", () => {
    const s = labelSamples(makeTile(0, 0, 3, 3, 1, id), new Uint8Array(9), [1]);
    expect(s.X).toBeInstanceOf(Float32Array);
    expect(s.y).toBeInstanceOf(Uint8Array);
    expect(s.y).toHaveLength(0);
  });

  it("a store spanning a 2x2 tile grid gives the same multiset of samples as one dense tile", () => {
    const W = 400, H = 300;
    const store = emptyStore(W, H);
    const masks = new Map();
    const dense = new Uint8Array(W * H);
    let s = 3;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let n = 0; n < 60; n++) {
      const w = { x0: Math.floor(rnd() * (W - 20)), y0: Math.floor(rnd() * (H - 20)), width: 1 + Math.floor(rnd() * 20), height: 1 + Math.floor(rnd() * 20) };
      const v = 1 + Math.floor(rnd() * 4);
      for (const k of tileKeys(w)) masks.set(k, new Uint8Array(8192));
      brush(store, masks, w, v, false);
      for (let r = w.y0; r < w.y0 + w.height; r++) for (let c = w.x0; c < w.x0 + w.width; c++) dense[r * W + c] = v;
    }
    const nan = (k: number, c: number, r: number) => ((c + r) % 23 === 0 ? NaN : id(k, c, r));
    const rows = (x: { X: Float32Array; y: Uint8Array }) => Array.from(x.y, (y, i) => `${x.X[2 * i]},${x.X[2 * i + 1]},${y}`);
    const windows = labelWindows(store);
    expect(windows).toHaveLength(4);
    const tiled = windows.flatMap((w) => rows(labelSamples(makeTile(w.x0, w.y0, w.width, w.height, 2, nan), store.tiles.get(`${w.x0},${w.y0}`)!, [1, 2])));
    const whole = rows(labelSamples(makeTile(0, 0, W, H, 2, nan), dense, [1, 2]));
    expect(whole.length).toBeGreaterThan(1000);
    expect(tiled.sort()).toEqual(whole.sort());
  });
});
