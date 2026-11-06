import { describe, expect, it } from "vitest";
import { POLYGON_MAX, polygonFits, polygonSpans } from "../../../src/core/polygon";
import type { Span } from "../../../src/core/spans";

// Spec 054 criterion 1.
const DIMS = { width: 60, height: 50 };
const cells = (spans: Span[]) => new Set(spans.flatMap((s) => Array.from({ length: s.x1 - s.x0 }, (_, i) => `${s.x0 + i},${s.row}`)));
type P = [number, number];

/** Even-odd ray casting at a point not on any edge. */
function inside(poly: P[], x: number, y: number): boolean {
  let odd = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}
/** Distance from a point to the polygon's outline. */
function edgeDistance(poly: P[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!, [bx, by] = poly[(i + 1) % poly.length]!;
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
  }
  return best;
}

describe("polygonSpans", () => {
  it("a rectangle's corners give exactly its pixels, corners and edges included, in either winding", () => {
    const rect: P[] = [[2, 3], [10, 3], [10, 8], [2, 8]];
    const want = new Set<string>();
    for (let r = 3; r <= 8; r++) for (let c = 2; c <= 10; c++) want.add(`${c},${r}`);
    expect(cells(polygonSpans(rect, DIMS))).toEqual(want);
    expect(cells(polygonSpans([...rect].reverse(), DIMS))).toEqual(want);
  });

  it("gives disjoint spans sorted by row then x0", () => {
    const spans = polygonSpans([[5, 5], [40, 9], [30, 40], [8, 30]], DIMS);
    for (let i = 1; i < spans.length; i++) {
      const a = spans[i - 1]!, b = spans[i]!;
      expect(a.row < b.row || (a.row === b.row && a.x1 < b.x0)).toBe(true);
    }
  });

  it("leaves a concave notch empty", () => {
    // a U: the notch is columns 14..26 above row 30
    const got = cells(polygonSpans([[5, 5], [12, 5], [12, 32], [28, 32], [28, 5], [35, 5], [35, 40], [5, 40]], DIMS));
    expect(got.has("20,10")).toBe(false);
    expect(got.has("20,36")).toBe(true);
    expect(got.has("8,20")).toBe(true);
    expect(got.has("31,20")).toBe(true);
  });

  it("random polygons: every pixel well inside is filled, none well outside is, and every corner is", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let k = 0; k < 40; k++) {
      // a star-shaped polygon around the centre, so it never crosses itself
      const n = 3 + rand(7), poly: P[] = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * (i + rand(100) / 250)) / n, rad = 6 + rand(16);
        poly.push([Math.round(30 + rad * Math.cos(a)), Math.round(25 + rad * Math.sin(a))]);
      }
      const got = cells(polygonSpans(poly, DIMS));
      for (const [c, r] of poly) expect(got.has(`${c},${r}`), `corner ${c},${r}`).toBe(true);
      for (let r = 0; r < DIMS.height; r++) for (let c = 0; c < DIMS.width; c++) {
        if (edgeDistance(poly, c, r) < 1) continue; // within a pixel of the outline either answer is right
        expect(got.has(`${c},${r}`), `polygon ${k} pixel ${c},${r}`).toBe(inside(poly, c, r));
      }
    }
  });

  it("a self-crossing outline fills by the even-odd rule", () => {
    // a bow tie: the two triangles are filled, the points left and right of the crossing are not
    const got = cells(polygonSpans([[10, 10], [40, 40], [40, 10], [10, 40]], DIMS));
    expect(got.has("36,25")).toBe(true);
    expect(got.has("14,25")).toBe(true);
    expect(got.has("25,13")).toBe(false);
    expect(got.has("25,37")).toBe(false);
  });

  it("clips to the raster, and gives one pixel for one corner and a line for two", () => {
    expect(cells(polygonSpans([[-5, -5], [70, -5], [70, 60], [-5, 60]], DIMS)).size).toBe(DIMS.width * DIMS.height);
    expect(polygonSpans([[4, 6]], DIMS)).toEqual([{ row: 6, x0: 4, x1: 5 }]);
    expect(cells(polygonSpans([[4, 6], [7, 9]], DIMS))).toEqual(new Set(["4,6", "5,7", "6,8", "7,9"]));
    expect(polygonSpans([], DIMS)).toEqual([]);
  });
});

describe("polygonFits", () => {
  it("allows a span of POLYGON_MAX pixels each way and no more", () => {
    expect(POLYGON_MAX).toBe(2048);
    expect(polygonFits([], [5000, 5000])).toBe(true);
    expect(polygonFits([[100, 100]], [100 + 2047, 100])).toBe(true);
    expect(polygonFits([[100, 100]], [100 + 2048, 100])).toBe(false);
    expect(polygonFits([[100, 100], [900, 100]], [500, 100 - 2048])).toBe(false);
    expect(polygonFits([[100, 100], [2147, 100]], [1000, 2147])).toBe(true);
  });
});
