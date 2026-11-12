import { describe, expect, it } from "vitest";
import type { Window } from "../../../src/core/grid";
import { holePixels, regionView, type HeldTile, type RegionView } from "../../../src/core/holes";

// Spec 059 tester: holePixels against a brute-force patch search (scope 1), on random grids and across tile seams.
type Cell = { label: number; valid: boolean; known: boolean };
const UNKNOWN: Cell = { label: 0, valid: false, known: false };

/** A seeded PRNG so failures repeat. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** R as spec 054 defines it: known valid pixels 4-connected to seed with its label. */
function flood(w: number, h: number, at: (x: number, y: number) => Cell, seed: [number, number]): Uint8Array {
  const R = new Uint8Array(w * h), c0 = at(...seed);
  if (!c0.known || !c0.valid) return R;
  const stack: [number, number][] = [seed];
  R[seed[1] * w + seed[0]] = 1;
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [a, b] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as [number, number][]) {
      if (a < 0 || b < 0 || a >= w || b >= h || R[b * w + a]) continue;
      const c = at(a, b);
      if (!c.known || !c.valid || c.label !== c0.label) continue;
      R[b * w + a] = 1;
      stack.push([a, b]);
    }
  }
  return R;
}

/** Scope 1 literally: 4-connected components of non-R pixels (off-window counts as unknown); a hole has <= 2 px, no unknown, all valid. */
function bruteHoles(w: number, h: number, at: (x: number, y: number) => Cell, R: Uint8Array, value: number): Set<string> {
  const seen = new Uint8Array(w * h), out = new Set<string>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (R[y * w + x] || seen[y * w + x]) continue;
    const comp: [number, number][] = [[x, y]];
    seen[y * w + x] = 1;
    let unknown = false;
    for (let n = 0; n < comp.length; n++) {
      const [cx, cy] = comp[n]!;
      if (!at(cx, cy).known) unknown = true;
      for (const [a, b] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as [number, number][]) {
        if (a < 0 || b < 0 || a >= w || b >= h) { unknown = true; continue; }
        if (R[b * w + a] || seen[b * w + a]) continue;
        seen[b * w + a] = 1;
        comp.push([a, b]);
      }
    }
    if (unknown || comp.length > 2 || comp.some(([a, b]) => !at(a, b).valid)) continue;
    for (const [a, b] of comp) if (at(a, b).label !== value) out.add(`${a},${b}`);
  }
  return out;
}

function wholeView(w: number, h: number, at: (x: number, y: number) => Cell, R: Uint8Array): RegionView {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  const cell = (x: number, y: number) => (on(x, y) ? at(x, y) : UNKNOWN);
  return {
    inRegion: (x, y) => on(x, y) && R[y * w + x] === 1,
    known: (x, y) => cell(x, y).known,
    valid: (x, y) => cell(x, y).known && cell(x, y).valid,
    label: (x, y) => (cell(x, y).known ? cell(x, y).label : 0),
  };
}

const keys = (t: Window, list: number[]) => list.map((i) => `${t.x0 + (i % t.width)},${t.y0 + Math.floor(i / t.width)}`);

describe("holePixels equals the brute-force patch definition", () => {
  it("on 400 random small grids with specks, nodata, unknown pixels and pixels of the value", () => {
    const rand = rng(59);
    let total = 0;
    for (let n = 0; n < 400; n++) {
      const w = 3 + Math.floor(rand() * 12), h = 3 + Math.floor(rand() * 12), value = 3;
      const cells: Cell[] = [];
      const pSpeck = 0.05 + rand() * 0.35;
      for (let i = 0; i < w * h; i++) {
        const r = rand();
        cells.push(r < 0.03 ? UNKNOWN : r < 0.07 ? { label: 2, valid: false, known: true } : rand() < pSpeck
          ? { label: [0, 2, 3][Math.floor(rand() * 3)]!, valid: true, known: true } : { label: 1, valid: true, known: true });
      }
      const at = (x: number, y: number) => cells[y * w + x]!;
      // seed on a label-1 pixel if there is one
      const s = cells.findIndex((c) => c.known && c.valid && c.label === 1);
      if (s < 0) continue;
      const R = flood(w, h, at, [s % w, Math.floor(s / w)]);
      const t: Window = { x0: 0, y0: 0, width: w, height: h };
      const got = keys(t, holePixels(t, wholeView(w, h, at, R), value));
      const want = bruteHoles(w, h, at, R, value);
      total += want.size;
      expect(new Set(got), `grid ${n}`).toEqual(want);
      // sorted tile-local indices
      const idx = holePixels(t, wholeView(w, h, at, R), value);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
    expect(total).toBeGreaterThan(100);
  });

  it("with an unlabelled target, enclosed specks of every other class are returned, and none of the value", () => {
    const w = 9, h = 3, labels = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 5, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const at = (x: number, y: number): Cell => ({ label: labels[y * w + x]!, valid: true, known: true });
    const R = flood(w, h, at, [0, 0]), t: Window = { x0: 0, y0: 0, width: w, height: h };
    expect(keys(t, holePixels(t, wholeView(w, h, at, R), 3))).toEqual(["1,1", "3,1", "5,1"]);
  });

  it("a 2 px pair is filled minus its pixel already of the value; a pair with one nodata pixel stays whole", () => {
    const rows = ["11111", "10311", "11111", "1x011", "11111"];
    const at = (x: number, y: number): Cell => (rows[y]![x] === "x" ? { label: 0, valid: false, known: true } : { label: Number(rows[y]![x]), valid: true, known: true });
    const R = flood(5, 5, at, [0, 0]), t: Window = { x0: 0, y0: 0, width: 5, height: 5 };
    expect(keys(t, holePixels(t, wholeView(5, 5, at, R), 3))).toEqual(["1,1"]);
  });

  it("returns nothing for an empty region and for a single-pixel window", () => {
    const at = (): Cell => ({ label: 0, valid: true, known: true });
    expect(holePixels({ x0: 0, y0: 0, width: 4, height: 4 }, wholeView(4, 4, at, new Uint8Array(16)), 3)).toEqual([]);
    const one = new Uint8Array(1);
    expect(holePixels({ x0: 0, y0: 0, width: 1, height: 1 }, wholeView(1, 1, at, one), 3)).toEqual([]);
  });
});

/** Tiles of a raster as fill would hold them, from a cell function and an R; `drop` tiles are unread. */
function heldTiles(W: number, H: number, at: (x: number, y: number) => Cell, R: Uint8Array, drop: Set<string>, nullLabels = false) {
  const tiles = new Map<string, HeldTile>();
  for (let y0 = 0; y0 < H; y0 += 256) for (let x0 = 0; x0 < W; x0 += 256) {
    const k = `${x0},${y0}`;
    if (drop.has(k)) continue;
    const t = { x0, y0, width: Math.min(256, W - x0), height: Math.min(256, H - y0) };
    const labels = new Uint8Array(t.width * t.height), bits = new Uint8Array(labels.length), mask = new Uint8Array(Math.ceil(labels.length / 8));
    for (let i = 0; i < labels.length; i++) {
      const x = x0 + (i % t.width), y = y0 + Math.floor(i / t.width), c = at(x, y);
      labels[i] = c.label;
      bits[i] = R[y * W + x]!;
      if (!c.valid) mask[i >> 3]! |= 1 << (i & 7);
    }
    tiles.set(k, { t, labels: nullLabels ? null : labels, mask, bits });
  }
  return tiles;
}

describe("holePixels tile by tile equals the whole-raster definition", () => {
  // 600 x 530: 3 x 3 tiles with a partial last column (88 px) and row (18 px)
  const W = 600, H = 530;
  /** Label 1 with dense random specks near seams, four-tile corners and the raster edges. */
  function raster(seed: number, drop: Set<string>) {
    const rand = rng(seed), cells = new Map<number, Cell>();
    const near = [0, 1, 254, 255, 256, 257, 510, 511, 512, 513, W - 2, W - 1, H - 2, H - 1];
    for (const cx of near) for (const cy of near) for (let k = 0; k < 6; k++) {
      const x = cx + Math.floor(rand() * 5) - 2, y = cy + Math.floor(rand() * 5) - 2;
      if (x < 0 || y < 0 || x >= W || y >= H || rand() < 0.4) continue;
      const r = rand();
      cells.set(y * W + x, r < 0.1 ? { label: 1, valid: false, known: true } : { label: r < 0.4 ? 0 : r < 0.7 ? 2 : 3, valid: true, known: true });
    }
    const tileKey = (x: number, y: number) => `${Math.floor(x / 256) * 256},${Math.floor(y / 256) * 256}`;
    const at = (x: number, y: number): Cell => (drop.has(tileKey(x, y)) ? UNKNOWN : cells.get(y * W + x) ?? { label: 1, valid: true, known: true });
    return at;
  }

  for (const [name, drop] of [["all tiles read", new Set<string>()], ["the right column and centre tile unread", new Set(["512,0", "512,256", "512,512", "256,256"])]] as const) {
    it(`on seams, four-tile corners, partial tiles and raster edges (${name})`, () => {
      for (const seed of [1, 2, 3, 4]) {
        const at = raster(seed, drop), R = flood(W, H, at, [128, 128]);
        const want = bruteHoles(W, H, at, R, 3);
        const tiles = heldTiles(W, H, at, R, drop), v = regionView({ width: W, height: H }, (k) => tiles.get(k));
        const got: string[] = [];
        for (const { t } of tiles.values()) {
          const own = keys(t, holePixels(t, v, 3));
          // each tile reports only its own pixels
          for (const k of own) {
            const [x, y] = k.split(",").map(Number) as [number, number];
            expect(x >= t.x0 && x < t.x0 + t.width && y >= t.y0 && y < t.y0 + t.height).toBe(true);
          }
          got.push(...own);
        }
        expect(got.length, `seed ${seed}: no pixel twice`).toBe(new Set(got).size);
        expect(new Set(got), `seed ${seed}`).toEqual(want);
        expect(want.size, `seed ${seed}: the case has holes`).toBeGreaterThan(0);
      }
    });
  }

  it("hand-placed seam cases: vertical and horizontal split pairs, a diagonal pair at a four-tile corner, a corner pixel, a pair by an unread tile, a speck on the last partial row", () => {
    const W2 = 600, H2 = 530, drop = new Set(["512,0"]);
    const specks = new Map<string, Cell>([
      ["255,40", { label: 0, valid: true, known: true }], ["256,40", { label: 2, valid: true, known: true }], // across a vertical seam
      ["40,255", { label: 0, valid: true, known: true }], ["40,256", { label: 0, valid: true, known: true }], // across a horizontal seam
      ["255,255", { label: 0, valid: true, known: true }], ["256,256", { label: 0, valid: true, known: true }], // diagonal at a four-tile corner
      ["256,511", { label: 2, valid: true, known: true }], // a tile's corner pixel
      ["510,100", { label: 0, valid: true, known: true }], ["511,100", { label: 0, valid: true, known: true }], // pair touching unread tile 512,0
      ["510,200", { label: 0, valid: true, known: true }], // speck one column from the unread tile: filled
      ["300,528", { label: 0, valid: true, known: true }], // with 300,529 a pair touching the raster edge: stays
      ["300,529", { label: 0, valid: true, known: true }], ["302,529", { label: 0, valid: true, known: true }], // the last row: stays
      ["599,300", { label: 0, valid: true, known: true }], // last column: stays
      ["598,400", { label: 0, valid: true, known: true }], // one in from the last column: filled
      ["512,300", { label: 0, valid: false, known: true }], // nodata on a seam: stays
    ]);
    const tileKey = (x: number, y: number) => `${Math.floor(x / 256) * 256},${Math.floor(y / 256) * 256}`;
    const at = (x: number, y: number): Cell => (drop.has(tileKey(x, y)) ? UNKNOWN : specks.get(`${x},${y}`) ?? { label: 1, valid: true, known: true });
    const R = flood(W2, H2, at, [100, 100]), tiles = heldTiles(W2, H2, at, R, drop), v = regionView({ width: W2, height: H2 }, (k) => tiles.get(k));
    const got = [...tiles.values()].flatMap(({ t }) => keys(t, holePixels(t, v, 3))).sort();
    expect(got).toEqual(["255,255", "255,40", "256,256", "256,40", "256,511", "40,255", "40,256", "510,200", "598,400"].sort());
    expect(new Set(got)).toEqual(bruteHoles(W2, H2, at, R, 3));
  });

  it("an unlabelled target in tiles with null labels: specks only in labelled tiles are holes", () => {
    const W2 = 512, H2 = 256, at = (x: number, y: number): Cell => ({ label: x === 300 && y === 100 ? 1 : 0, valid: true, known: true });
    const R = flood(W2, H2, at, [10, 10]), tiles = heldTiles(W2, H2, at, R, new Set());
    tiles.set("0,0", { ...tiles.get("0,0")!, labels: null });
    const v = regionView({ width: W2, height: H2 }, (k) => tiles.get(k));
    expect([...tiles.values()].flatMap(({ t }) => keys(t, holePixels(t, v, 3)))).toEqual(["300,100"]);
  });
});
