import type { Window } from "./grid";
import { tileWindow } from "./labelStore";
import { TILE_SIZE } from "./types";
import { validAt, type ValidMask } from "./validMask";

/** A fill spreads at most this many tiles from the clicked tile each way (spec 054), so it reads at most 81 tiles. */
export const FILL_REACH = 4;

/** The pixels a fillTile call newly filled on each edge of its tile: rows on the left and right, columns on the top and bottom. */
export type FillEdges = { left: number[]; right: number[]; up: number[]; down: number[] };

/** Spreads a 4-connected fill in tile window t from seed pixel indices, over valid pixels labelled `target`; sets their bits and returns the edge pixels it filled. */
// labels null means every label is 0. The bits carry over between calls, so a tile the fill enters again only grows.
export function fillTile(labels: Uint8Array | null, mask: ValidMask, t: Window, target: number, bits: Uint8Array, seeds: number[]): FillEdges {
  const { width: w, height: h } = t, out: FillEdges = { left: [], right: [], up: [], down: [] };
  const stack: number[] = [];
  const take = (i: number) => {
    if (bits[i] || (labels ? labels[i] : 0) !== target || !validAt(mask, i)) return;
    bits[i] = 1;
    stack.push(i);
  };
  for (const s of seeds) take(s);
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i - x) / w;
    if (x > 0) take(i - 1); else out.left.push(y);
    if (x < w - 1) take(i + 1); else out.right.push(y);
    if (y > 0) take(i - w); else out.up.push(x);
    if (y < h - 1) take(i + w); else out.down.push(x);
  }
  return out;
}

/** The seeds tile t's filled edges give each neighbouring tile on the raster: its window and the pixel indices facing the edge. */
export function edgeSeeds(dims: { width: number; height: number }, t: Window, edges: FillEdges): { t: Window; seeds: number[] }[] {
  const out: { t: Window; seeds: number[] }[] = [];
  const add = (x0: number, y0: number, cells: number[], index: (n: Window, k: number) => number) => {
    if (!cells.length || x0 < 0 || y0 < 0 || x0 >= dims.width || y0 >= dims.height) return;
    const n = tileWindow(dims, x0, y0);
    out.push({ t: n, seeds: cells.map((k) => index(n, k)) });
  };
  add(t.x0 - TILE_SIZE, t.y0, edges.left, (n, y) => y * n.width + n.width - 1);
  add(t.x0 + TILE_SIZE, t.y0, edges.right, (n, y) => y * n.width);
  add(t.x0, t.y0 - TILE_SIZE, edges.up, (n, x) => (n.height - 1) * n.width + x);
  add(t.x0, t.y0 + TILE_SIZE, edges.down, (_n, x) => x);
  return out;
}

/** The tile at origin (x0, y0) is within FILL_REACH tiles of the tile holding the cell. */
export const inReach = ([col, row]: [number, number], x0: number, y0: number): boolean =>
  Math.abs(x0 / TILE_SIZE - Math.floor(col / TILE_SIZE)) <= FILL_REACH && Math.abs(y0 / TILE_SIZE - Math.floor(row / TILE_SIZE)) <= FILL_REACH;
