import type { Window } from "./grid";
import { TILE_SIZE } from "./types";
import { validAt, type ValidMask } from "./validMask";

/** A fill also fills the patches it encloses of at most this many pixels (spec 059). */
export const HOLE_MAX = 2;

/** A fill's region and what it read, in raster coordinates; unknown pixels (off the raster or unread) give false or 0. */
export type RegionView = {
  inRegion(x: number, y: number): boolean;
  known(x: number, y: number): boolean;
  valid(x: number, y: number): boolean;
  label(x: number, y: number): number;
};

/** One tile a fill holds: its window, effective labels (null: all 0), valid mask and region bits. */
export type HeldTile = { t: Window; labels: Uint8Array | null; mask: ValidMask; bits: Uint8Array };

// left, right, up, down
const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];

/** Tile-local indices of t's pixels in holes of the region (spec 059), minus those labelled `value`, sorted. */
// A patch of at most 2 px is P alone (all 4 sides in R) or P plus one side Q whose other 3 sides are in R; so the test is local.
export function holePixels(t: Window, view: RegionView, value: number): number[] {
  const out: number[] = [];
  const q: [number, number] = [0, 0];
  /** Counts the sides of (x, y) not in R, other than `skip`, stopping at 2; the last one found is left in q. */
  const outside = (x: number, y: number, skip: number): number => {
    let n = 0;
    for (let s = 0; s < 4; s++) {
      if (s === skip) continue;
      const a = x + DX[s]!, b = y + DY[s]!;
      if (view.inRegion(a, b)) continue;
      q[0] = a; q[1] = b;
      if (++n > 1) break;
    }
    return n;
  };
  for (let j = 0; j < t.height; j++) for (let i = 0; i < t.width; i++) {
    const x = t.x0 + i, y = t.y0 + j;
    if (view.inRegion(x, y) || !view.known(x, y) || !view.valid(x, y) || view.label(x, y) === value) continue;
    const n = outside(x, y, -1);
    if (n > 1) continue;
    if (n === 1) {
      const [a, b] = q, back = a < x ? 1 : a > x ? 0 : b < y ? 3 : 2; // the side of Q that faces P
      if (!view.known(a, b) || !view.valid(a, b) || outside(a, b, back) !== 0) continue;
    }
    out.push(j * t.width + i);
  }
  return out;
}

/** A RegionView over the tiles `held` returns by LabelStore key; tiles it lacks are unknown. */
export function regionView(dims: { width: number; height: number }, held: (key: string) => HeldTile | undefined): RegionView {
  // keyed by tile number so a lookup builds no string after the first
  const cache = new Map<number, HeldTile | null>(), across = Math.ceil(dims.width / TILE_SIZE);
  const at = (x: number, y: number): [HeldTile, number] | null => {
    if (x < 0 || y < 0 || x >= dims.width || y >= dims.height) return null;
    const tx = Math.floor(x / TILE_SIZE), ty = Math.floor(y / TILE_SIZE), n = ty * across + tx;
    let h = cache.get(n);
    if (h === undefined) { h = held(`${tx * TILE_SIZE},${ty * TILE_SIZE}`) ?? null; cache.set(n, h); }
    return h ? [h, (y - h.t.y0) * h.t.width + (x - h.t.x0)] : null;
  };
  return {
    inRegion: (x, y) => { const a = at(x, y); return a !== null && !!a[0].bits[a[1]]; },
    known: (x, y) => at(x, y) !== null,
    valid: (x, y) => { const a = at(x, y); return a !== null && validAt(a[0].mask, a[1]); },
    label: (x, y) => { const a = at(x, y); return a && a[0].labels ? a[0].labels[a[1]]! : 0; },
  };
}
