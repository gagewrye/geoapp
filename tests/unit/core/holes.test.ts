import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import { HOLE_MAX, holePixels, regionView, type RegionView } from "../../../src/core/holes";

// Spec 059 criteria 1 to 3.
type Px = (x: number, y: number) => number;
type Cell = { label: number; valid: boolean; known: boolean };

/** A whole-window view: R is the 4-connected fill from `seed` over known valid pixels of its label; pixels off the window are unknown. */
function view(w: number, h: number, at: (x: number, y: number) => Cell, seed: [number, number]): RegionView {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  const cell = (x: number, y: number): Cell => (on(x, y) ? at(x, y) : { label: 0, valid: false, known: false });
  const target = cell(...seed).label, R = new Uint8Array(w * h), stack: [number, number][] = [seed];
  R[seed[1] * w + seed[0]] = 1;
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [a, b] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as [number, number][]) {
      const c = cell(a, b);
      if (!on(a, b) || R[b * w + a] || !c.known || !c.valid || c.label !== target) continue;
      R[b * w + a] = 1;
      stack.push([a, b]);
    }
  }
  return {
    inRegion: (x, y) => on(x, y) && R[y * w + x] === 1,
    known: (x, y) => cell(x, y).known,
    valid: (x, y) => cell(x, y).known && cell(x, y).valid,
    label: (x, y) => (cell(x, y).known ? cell(x, y).label : 0),
  };
}

/** Rows of characters: a digit is a label, x is nodata (label 2 underneath), ? is unknown. */
function grid(...rows: string[]) {
  const w = rows[0]!.length, h = rows.length;
  const at = (x: number, y: number): Cell => {
    const ch = rows[y]![x]!;
    return ch === "?" ? { label: 0, valid: false, known: false } : ch === "x" ? { label: 2, valid: false, known: true } : { label: Number(ch), valid: true, known: true };
  };
  const t: Window = { x0: 0, y0: 0, width: w, height: h };
  /** The holes of a fill of `value` from `seed`, as "x,y". */
  return (value: number, seed: [number, number] = [0, 0]) => holePixels(t, view(w, h, at, seed), value).map((i) => `${i % w},${Math.floor(i / w)}`);
}

describe("holePixels", () => {
  it("caps holes at 2 px", () => expect(HOLE_MAX).toBe(2));

  it("fills 1 px specks of any other label, 4-adjacent pairs, diagonal pairs and diagonal lines pixel by pixel", () => {
    expect(grid(
      "1111111111",
      "1011121111",
      "1111111111",
      "1001111011",
      "1111111101",
      "1011111111",
      "1101111111",
      "1110111111",
      "1111111111",
    )(3)).toEqual(["1,1", "5,1", "1,3", "2,3", "7,3", "8,4", "1,5", "2,6", "3,7"]);
  });

  it("fills a pixel whose 4 sides are in R even when its diagonal neighbour joins a large outside area", () => {
    expect(grid(
      "11111",
      "10111",
      "11000",
      "11000",
      "11000",
    )(3)).toEqual(["1,1"]);
  });

  it("leaves 3 px patches, notches, pairs touching the outside, and specks by the edge or unknown pixels", () => {
    expect(grid(
      "1111111111",
      "1000110111",
      "1111110011",
      "1111111111",
      "1111110?11",
      "1111111111",
      "1111111111",
      "0111011111",
    )(3)).toEqual([]);
    // a notch with one side on the outside, and a pair with one pixel touching it
    expect(grid(
      "111111",
      "101101",
      "110100",
      "110000",
      "100000",
    )(3)).toEqual(["1,1"]);
  });

  it("leaves nodata, patches holding nodata, and pixels already of the value", () => {
    expect(grid(
      "11111111",
      "1x11x211",
      "11111111",
      "11131111",
      "11111111",
    )(3)).toEqual([]);
  });

  it("with the target 0, a class-2 speck in the region is a hole", () => {
    expect(grid(
      "0000",
      "0200",
      "0000",
    )(3)).toEqual(["1,1"]);
  });
});

describe("regionView", () => {
  const dims = { width: 300, height: 260 };
  const t: Window = { x0: 0, y0: 0, width: 256, height: 256 };
  const bits = new Uint8Array(256 * 256), mask = new Uint8Array(256 * 256 / 8);
  bits[1] = 1;
  mask[0] = 0b100; // pixel 2 is nodata
  const v = regionView(dims, (k) => (k === "0,0" ? { t, labels: null, mask, bits } : undefined));

  it("reads held tiles, null labels as 0", () => {
    expect([v.inRegion(1, 0), v.inRegion(0, 0), v.known(0, 0), v.valid(0, 0), v.valid(2, 0), v.label(5, 5)]).toEqual([true, false, true, true, false, 0]);
  });

  it("gives false or 0 off the raster and in tiles it doesn't hold", () => {
    for (const [x, y] of [[-1, 0], [0, -1], [300, 0], [0, 260], [256, 0], [0, 256]] as [number, number][]) {
      expect([v.inRegion(x, y), v.known(x, y), v.valid(x, y), v.label(x, y)], `${x},${y}`).toEqual([false, false, false, 0]);
    }
  });
});

describe("holePixels across tile seams", () => {
  const W = 768, H = 768;
  const dims = { width: W, height: H };
  /** Label 1 everywhere, with 0 specks on seams and corners of 256 px tiles. */
  const specks = new Set(["255,100", "256,100", "100,255", "100,256", "255,255", "256,256", "400,256", "511,511", "300,300", "300,301", "300,302"]);
  const label: Px = (x, y) => (specks.has(`${x},${y}`) ? 0 : 1);
  const whole = view(W, H, (x, y) => ({ label: label(x, y), valid: true, known: true }), [0, 0]);

  it("finds the same holes tile by tile as over the whole window, each pixel from its own tile", () => {
    const want = holePixels({ x0: 0, y0: 0, width: W, height: H }, whole, 3).map((i) => `${i % W},${Math.floor(i / W)}`);
    expect(want).toEqual(["255,100", "256,100", "100,255", "255,255", "100,256", "256,256", "400,256", "511,511"]);
    const tiles = new Map<string, { t: Window; labels: Uint8Array; mask: "all"; bits: Uint8Array }>();
    for (const y0 of [0, 256, 512]) for (const x0 of [0, 256, 512]) {
      const t = { x0, y0, width: 256, height: 256 }, labels = new Uint8Array(256 * 256), bits = new Uint8Array(256 * 256);
      for (let i = 0; i < labels.length; i++) {
        const x = x0 + (i % 256), y = y0 + Math.floor(i / 256);
        labels[i] = label(x, y);
        bits[i] = whole.inRegion(x, y) ? 1 : 0;
      }
      tiles.set(`${x0},${y0}`, { t, labels, mask: "all", bits });
    }
    const v = regionView(dims, (k) => tiles.get(k));
    const got: string[] = [];
    for (const { t } of tiles.values()) for (const i of holePixels(t, v, 3)) got.push(`${t.x0 + (i % 256)},${t.y0 + Math.floor(i / 256)}`);
    expect(got.sort()).toEqual([...want].sort());
  });
});
