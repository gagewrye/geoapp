import { AEF_NODATA_Q, AEF_RES, type Aoi } from "./aef";
import { northUpAffine } from "./geotags";
import type { Window } from "./grid";
import { TILE_SIZE } from "./types";
import type { Affine } from "./types";

/** A COG in AOI pixels: north-up offset of its top-left corner, its size, and its row order. */
export type Placement = { col: number; row: number; width: number; height: number; bottomUp: boolean };

/** Part of an AOI window covered by a COG: file pixel window [c0, r0, c1, r1] and offset in the window. */
export type Overlap = { src: [number, number, number, number]; dx: number; dy: number; w: number; h: number; bottomUp: boolean };

// Index bounds are whole metres; anything further off is a different grid.
const TOL = 1e-6;
const whole = (v: number) => Math.abs(v - Math.round(v)) < TOL;

/** Where a COG sits on the AOI grid, or null when it is rotated, not 10 m, or not a whole pixel off. */
export function placeCog(aoi: Aoi, gt: Affine, width: number, height: number): Placement | null {
  if (gt[1] !== AEF_RES || gt[2] !== 0 || gt[4] !== 0 || Math.abs(gt[5]) !== AEF_RES) return null;
  const [x0, , , top] = northUpAffine(gt, height);
  const col = (x0 - aoi.gt[0]) / AEF_RES;
  const row = (aoi.gt[3] - top) / AEF_RES;
  if (!whole(col) || !whole(row)) return null;
  return { col: Math.round(col), row: Math.round(row), width, height, bottomUp: gt[5] > 0 };
}

/** The COG's share of one AOI window, or null when they share no pixel. */
export function overlapWindow(p: Placement, win: Window): Overlap | null {
  const c0 = Math.max(p.col, win.x0), c1 = Math.min(p.col + p.width, win.x0 + win.width);
  const r0 = Math.max(p.row, win.y0), r1 = Math.min(p.row + p.height, win.y0 + win.height);
  if (c1 <= c0 || r1 <= r0) return null;
  // north-up COG rows [r0 - row, r1 - row); a bottom-up file stores them counted from the south
  const fr0 = p.bottomUp ? p.height - (r1 - p.row) : r0 - p.row;
  return { src: [c0 - p.col, fr0, c1 - p.col, fr0 + (r1 - r0)], dx: c0 - win.x0, dy: r0 - win.y0, w: c1 - c0, h: r1 - r0, bottomUp: p.bottomUp };
}

/**
 * Paste one band of a file window (row-major, file row order) into a window band, north-up,
 * filling only pixels that are still no data: valid values are never overwritten, so the first
 * COG pasted with a valid value wins and a COG's -128 never erases another's pixel.
 */
export function pasteBand(dst: Int8Array, dstWidth: number, src: Int8Array, o: Overlap): void {
  for (let i = 0; i < o.h; i++) {
    const at = (o.dy + (o.bottomUp ? o.h - 1 - i : i)) * dstWidth + o.dx;
    for (let j = 0; j < o.w; j++) if (dst[at + j] === AEF_NODATA_Q) dst[at + j] = src[i * o.w + j]!;
  }
}

/**
 * For each file tile (index ty * tilesAcross + tx within one band) overlapping the AOI, the
 * row-major index of the last AOI window that reads it; after that window its bytes can go.
 */
export function tileLastWindow(p: Placement, tileW: number, tileH: number, aoiW: number, aoiH: number, size = TILE_SIZE): Map<number, number> {
  const across = Math.ceil(p.width / tileW), down = Math.ceil(p.height / tileH);
  const windowsAcross = Math.ceil(aoiW / size);
  const out = new Map<number, number>();
  for (let ty = 0; ty < down; ty++) {
    const f0 = ty * tileH, f1 = Math.min(f0 + tileH, p.height); // file rows
    const n0 = p.bottomUp ? p.height - f1 : f0, n1 = p.bottomUp ? p.height - f0 : f1; // north-up rows
    const r1 = Math.min(p.row + n1, aoiH);
    if (r1 <= Math.max(p.row + n0, 0)) continue;
    for (let tx = 0; tx < across; tx++) {
      const c0 = Math.max(p.col + tx * tileW, 0), c1 = Math.min(p.col + Math.min((tx + 1) * tileW, p.width), aoiW);
      if (c1 <= c0) continue;
      // row-major order: the window holding the tile's last AOI row and column comes last
      out.set(ty * across + tx, Math.floor((r1 - 1) / size) * windowsAcross + Math.floor((c1 - 1) / size));
    }
  }
  return out;
}
