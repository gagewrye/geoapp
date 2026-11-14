import { describe, expect, it } from "vitest";
import { tileWindows } from "../../../src/core/grid";
import { brush, brushSpans, emptyStore, type LabelStore, type NodataMasks } from "../../../src/core/labelStore";
import { nodataMask } from "../../../src/core/nodata";
import { footprint } from "../../../src/core/pixel";
import { spanKeys, spansBox, sweptSpans, windowSpans, type Span } from "../../../src/core/spans";
import type { ValidMask } from "../../../src/core/validMask";
import { makeTile } from "../helpers/tiles";

// Spec 023 criteria 1 (sweptSpans, brute force) and 2 (brushSpans against per-cell brush).

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Pixels of spans as "c,r", failing on overlap or an unsorted list. */
function pixelsOf(spans: Span[]): Set<string> {
  const out = new Set<string>();
  let prev: Span | null = null;
  for (const s of spans) {
    expect(s.x1).toBeGreaterThan(s.x0);
    if (prev) expect(s.row > prev.row || (s.row === prev.row && s.x0 > prev.x1)).toBe(true); // sorted, disjoint, merged
    for (let c = s.x0; c < s.x1; c++) out.add(`${c},${s.row}`);
    prev = s;
  }
  return out;
}

describe("sweptSpans (criterion 1)", () => {
  it("equals the union of footprints over random cells, sides 1-127, clipped at the edges", { timeout: 30_000 }, () => {
    const r = rng(7);
    const dims = { width: 300, height: 200 };
    for (let t = 0; t < 60; t++) {
      const side = 1 + 2 * Math.floor(r() * 64);
      const n = 1 + Math.floor(r() * 12);
      const cells: [number, number][] = Array.from({ length: n }, () => [Math.floor(r() * 400) - 50, Math.floor(r() * 300) - 50]);
      const want = new Set<string>();
      for (const [c, rr] of cells) {
        const w = footprint(dims, c, rr, side);
        if (w) for (let y = w.y0; y < w.y0 + w.height; y++) for (let x = w.x0; x < w.x0 + w.width; x++) want.add(`${x},${y}`);
      }
      const got = pixelsOf(sweptSpans(cells, side, dims));
      expect(got.size).toBe(want.size);
      for (const p of want) expect(got.has(p), `${p} side ${side}`).toBe(true);
    }
  });

  it("is empty when every footprint misses the raster; spanKeys and spansBox cover exactly the spans", () => {
    expect(sweptSpans([[-200, -200]], 7, { width: 100, height: 100 })).toEqual([]);
    const spans = sweptSpans([[250, 250], [260, 262]], 15, { width: 600, height: 600 });
    expect(spanKeys(spans)).toEqual(["0,0", "256,0", "0,256", "256,256"]);
    expect(spansBox(spans)).toEqual({ x0: 243, y0: 243, width: 25, height: 27 });
    expect(windowSpans({ x0: 3, y0: 4, width: 2, height: 2 })).toEqual([{ row: 4, x0: 3, x1: 5 }, { row: 5, x0: 3, x1: 5 }]);
  });
});

/** Masks for every tile, nodata where `nd`. */
function masksFor(store: LabelStore, nd: (c: number, r: number) => boolean): NodataMasks {
  const m: NodataMasks = new Map();
  for (const w of tileWindows(store.width, store.height)) m.set(`${w.x0},${w.y0}`, nodataMask(makeTile(w.x0, w.y0, w.width, w.height, 1, (_k, c, r) => (nd(c, r) ? NaN : 1))));
  return m;
}
const clone = (s: LabelStore): LabelStore => ({ ...s, tiles: new Map([...s.tiles].map(([k, t]) => [k, t.slice()])) });
function expectSame(a: LabelStore, b: LabelStore) {
  expect([...a.tiles.keys()].sort()).toEqual([...b.tiles.keys()].sort());
  for (const [k, t] of a.tiles) expect(Buffer.from(t).equals(Buffer.from(b.tiles.get(k)!)), k).toBe(true);
}

describe("brushSpans (criterion 2)", () => {
  const dims = { width: 900, height: 700 };
  const nd = (c: number, r: number) => (c + 2 * r) % 13 === 0 || (c > 600 && r > 400);
  for (const base of [false, true]) {
    it(`gives tiles byte-equal to brush per cell over random strokes (base ${base})`, () => {
      const r = rng(base ? 3 : 4);
      const per = { ...emptyStore(dims.width, dims.height), base };
      const masks = masksFor(per, nd);
      for (let t = 0; t < 40; t++) {
        const side = 1 + 2 * Math.floor(r() * 40);
        const erase = r() < 0.35, value = 1 + Math.floor(r() * 3);
        const start: [number, number] = [Math.floor(r() * 950) - 25, Math.floor(r() * 750) - 25];
        const cells: [number, number][] = [start];
        for (let k = 0; k < 15; k++) { const [c, rr] = cells[cells.length - 1]!; cells.push([c + Math.floor(r() * 9) - 4, rr + Math.floor(r() * 9) - 4]); }
        const swept = clone(per);
        for (const [c, rr] of cells) { const w = footprint(dims, c, rr, side); if (w) brush(per, masks, w, value, erase); }
        brushSpans(swept, masks as Map<string, ValidMask>, sweptSpans(cells, side, dims), value, erase);
        expectSame(swept, per);
      }
    });
  }

  it("uses uniform masks: \"none\" labels nothing and creates no tile, \"all\" labels every pixel", () => {
    const s = emptyStore(600, 300);
    const masks = new Map<string, ValidMask>([["0,0", "none"], ["256,0", "all"]]);
    brushSpans(s, masks, windowSpans({ x0: 250, y0: 10, width: 12, height: 3 }), 2, false);
    expect([...s.tiles.keys()]).toEqual(["256,0"]);
    expect(s.tiles.get("256,0")!.filter((v) => v === 2).length).toBe(6 * 3);
  });

  it("throws on a missing mask", () => {
    expect(() => brushSpans(emptyStore(300, 300), new Map(), windowSpans({ x0: 0, y0: 0, width: 2, height: 2 }), 1, false)).toThrow();
  });
});
