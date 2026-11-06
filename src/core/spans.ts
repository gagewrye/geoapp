import type { Window } from "./grid";
import { TILE_SIZE } from "./types";

/** Pixels x0 <= col < x1 of one raster row (spec 023 F6). */
export type Span = { row: number; x0: number; x1: number };

/** The union of the side x side footprints of the cells, clipped to dims, as disjoint spans sorted by row then x0. */
// One interval per cell per row, about L·s, instead of L·s² pixel writes.
export function sweptSpans(cells: [number, number][], side: number, dims: { width: number; height: number }): Span[] {
  const h = (side - 1) / 2;
  const rows = new Map<number, [number, number][]>();
  for (const [c, r] of cells) {
    const x0 = Math.max(0, c - h), x1 = Math.min(dims.width, c + h + 1);
    if (x1 <= x0) continue;
    for (let y = Math.max(0, r - h), y1 = Math.min(dims.height, r + h + 1); y < y1; y++) {
      let list = rows.get(y);
      if (!list) rows.set(y, (list = []));
      list.push([x0, x1]);
    }
  }
  return mergeRows(rows);
}

/** Each row's [x0, x1) intervals merged into disjoint spans, sorted by row then x0 (the lists are sorted in place). */
export function mergeRows(rows: Map<number, [number, number][]>): Span[] {
  const out: Span[] = [];
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const list = rows.get(row)!.sort((a, b) => a[0] - b[0]);
    let [x0, x1] = list[0]!;
    for (const [a, b] of list.slice(1)) {
      if (a <= x1) x1 = Math.max(x1, b);
      else { out.push({ row, x0, x1 }); [x0, x1] = [a, b]; }
    }
    out.push({ row, x0, x1 });
  }
  return out;
}

/** A window as spans, one per row. */
export function windowSpans(w: Window): Span[] {
  return Array.from({ length: w.height }, (_, i) => ({ row: w.y0 + i, x0: w.x0, x1: w.x0 + w.width }));
}

/** Keys of the tile windows the spans meet, row-major. */
export function spanKeys(spans: Span[]): string[] {
  const keys = new Set<string>();
  for (const s of spans) {
    const y = Math.floor(s.row / TILE_SIZE) * TILE_SIZE;
    for (let x = Math.floor(s.x0 / TILE_SIZE) * TILE_SIZE; x < s.x1; x += TILE_SIZE) keys.add(`${x},${y}`);
  }
  return [...keys].sort((a, b) => {
    const [ax, ay] = a.split(",").map(Number) as [number, number], [bx, by] = b.split(",").map(Number) as [number, number];
    return ay - by || ax - bx;
  });
}

/** The smallest window holding every span; null for none. */
export function spansBox(spans: Span[]): Window | null {
  if (!spans.length) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of spans) { x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x1); y0 = Math.min(y0, s.row); y1 = Math.max(y1, s.row + 1); }
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}
