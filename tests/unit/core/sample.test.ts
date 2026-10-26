import { describe, expect, it } from "vitest";
import { samplePixels } from "../../../src/core/sample";
import type { PixelPolygon } from "../../../src/core/types";
import { colRow, makeTile } from "../helpers/tiles";

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const pixels = (X: Float32Array, nb: number) => {
  const out: string[] = [];
  for (let i = 0; i < X.length; i += nb) out.push(`${X[i]},${X[i + 1]}`);
  return out.sort();
};

describe("samplePixels (criterion 5)", () => {
  const tile = makeTile(0, 0, 6, 6, 2, colRow);

  it("includes pixels by the centre rule", () => {
    const { X, y } = samplePixels(tile, [{ label: 2, rings: [rect(1, 1, 3, 3)] }], [1, 2]);
    expect(pixels(X, 2)).toEqual(["1,1", "1,2", "2,1", "2,2"]);
    expect([...y]).toEqual([2, 2, 2, 2]);
    expect(samplePixels(tile, [{ label: 0, rings: [rect(0.6, 0.6, 1.4, 1.4)] }], [1, 2]).y).toHaveLength(0);
    expect(pixels(samplePixels(tile, [{ label: 0, rings: [rect(1.4, 1.4, 1.6, 1.6)] }], [1, 2]).X, 2)).toEqual(["1,1"]);
  });

  it("uses the even-odd rule for a triangle", () => {
    const { X } = samplePixels(tile, [{ label: 0, rings: [[[0, 0], [4, 0], [0, 4]]] }], [1, 2]);
    // centre (c+.5, r+.5) inside when c + r + 1 < 4
    expect(pixels(X, 2)).toEqual(["0,0", "0,1", "0,2", "1,0", "1,1", "2,0"]);
  });

  it("excludes holes", () => {
    const { X } = samplePixels(tile, [{ label: 0, rings: [rect(0, 0, 3, 3), rect(1, 1, 2, 2)] }], [1, 2]);
    expect(pixels(X, 2)).toHaveLength(8);
    expect(pixels(X, 2)).not.toContain("1,1");
  });

  it("drops nodata and NaN only on model bands", () => {
    const t = makeTile(0, 0, 4, 4, 3, (k, c, r) => (k === 0 && c === 1 && r === 1 ? -9 : k === 1 && c === 2 && r === 1 ? NaN : k === 2 && c === 1 && r === 2 ? -9 : colRow(k, c, r)), -9);
    const polys = [{ label: 0, rings: [rect(0, 0, 4, 4)] }];
    const a = samplePixels(t, polys, [1, 2]);
    expect(a.y).toHaveLength(14);
    expect(samplePixels(t, polys, [3]).y).toHaveLength(15);
    expect([...samplePixels(t, polys, [3]).X].every((v) => v !== -9)).toBe(true);
  });

  it("drops conflicting labels but keeps same-label overlaps once", () => {
    const polys: PixelPolygon[] = [{ label: 0, rings: [rect(0, 0, 2, 1)] }, { label: 1, rings: [rect(1, 0, 3, 1)] }, { label: 1, rings: [rect(2, 0, 4, 1)] }];
    const { X, y } = samplePixels(tile, polys, [1, 2]);
    expect(pixels(X, 2)).toEqual(["0,0", "2,0", "3,0"]);
    expect([...y].sort()).toEqual([0, 1, 1]);
  });

  it("selects bands in the given order", () => {
    const { X } = samplePixels(tile, [{ label: 0, rings: [rect(4, 3, 5, 4)] }], [2, 1]);
    expect([...X]).toEqual([3, 4]);
  });

  it("gives the same multiset over a 2x2 tile grid as over one tile", () => {
    const big = makeTile(0, 0, 8, 8, 2, colRow);
    const polys: PixelPolygon[] = [
      { label: 0, rings: [[[0.2, 0.3], [7.1, 1.2], [5.3, 7.7], [1.1, 6.4]], rect(3, 3, 4.6, 4.2)] },
      { label: 1, rings: [[[6, 0], [8, 0], [8, 8]]] },
    ];
    const whole = samplePixels(big, polys, [1, 2]);
    const parts: string[] = [];
    for (const [x0, y0] of [[0, 0], [4, 0], [0, 4], [4, 4]] as const) {
      const s = samplePixels(makeTile(x0, y0, 4, 4, 2, colRow), polys, [1, 2]);
      for (let i = 0; i < s.y.length; i++) parts.push(`${s.X[2 * i]},${s.X[2 * i + 1]},${s.y[i]}`);
    }
    const all: string[] = [];
    for (let i = 0; i < whole.y.length; i++) all.push(`${whole.X[2 * i]},${whole.X[2 * i + 1]},${whole.y[i]}`);
    expect(all.length).toBeGreaterThan(20);
    expect(parts.sort()).toEqual(all.sort());
  });
});
