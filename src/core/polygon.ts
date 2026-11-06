import { strokeCells } from "./pixel";
import { mergeRows, type Span } from "./spans";

/** A polygon's corners span at most this many pixels each way (spec 054), so one fill meets at most 81 tiles. */
export const POLYGON_MAX = 2048;

/** The corners with `next` added still span at most POLYGON_MAX pixels each way. */
export function polygonFits(corners: [number, number][], next: [number, number]): boolean {
  let x0 = next[0], x1 = next[0], y0 = next[1], y1 = next[1];
  for (const [c, r] of corners) { x0 = Math.min(x0, c); x1 = Math.max(x1, c); y0 = Math.min(y0, r); y1 = Math.max(y1, r); }
  return x1 - x0 < POLYGON_MAX && y1 - y0 < POLYGON_MAX;
}

/** The pixels of the closed polygon through the corners (pixel centres), clipped to dims: centres inside it (even-odd) plus the Bresenham cells of each edge. */
// The edge cells make the result independent of how a centre exactly on an edge would round, and include every corner.
// Even-odd means a self-crossing outline leaves holes.
export function polygonSpans(corners: [number, number][], dims: { width: number; height: number }): Span[] {
  const rows = new Map<number, [number, number][]>();
  const add = (row: number, x0: number, x1: number) => {
    x0 = Math.max(0, x0); x1 = Math.min(dims.width, x1);
    if (row < 0 || row >= dims.height || x1 <= x0) return;
    let list = rows.get(row);
    if (!list) rows.set(row, (list = []));
    list.push([x0, x1]);
  };
  const n = corners.length;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    y0 = Math.min(y0, corners[i]![1]); y1 = Math.max(y1, corners[i]![1]);
    for (const [c, r] of strokeCells(corners[i]!, corners[(i + 1) % n]!)) add(r, c, c + 1);
  }
  for (let row = Math.max(0, y0); row <= Math.min(dims.height - 1, y1); row++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = corners[i]!, b = corners[(i + 1) % n]!, [lo, hi] = a[1] < b[1] ? [a, b] : [b, a];
      // half-open in rows, so a corner on this row counts once
      if (lo[1] <= row && row < hi[1]) xs.push(lo[0] + ((row - lo[1]) * (hi[0] - lo[0])) / (hi[1] - lo[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) add(row, Math.ceil(xs[k]!), Math.floor(xs[k + 1]!) + 1);
  }
  return mergeRows(rows);
}
