import type { PixelPolygon, Tile } from "./types";

export const NONE = -1;
export const CONFLICT = -2;

/** Bounding box [minCol, minRow, maxCol, maxRow] of a polygon's outer ring. */
export function bbox(p: PixelPolygon): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p.rings[0] ?? []) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Per-pixel label for a tile: label, NONE, or CONFLICT when labels differ. Centre rule, even-odd. */
export function labelMap(tile: Pick<Tile, "x0" | "y0" | "width" | "height">, polygons: PixelPolygon[]): Int16Array {
  const { x0, y0, width, height } = tile;
  const out = new Int16Array(width * height).fill(NONE);
  const xs: number[] = [];
  for (const p of polygons) {
    const [, by0, , by1] = bbox(p);
    const rStart = Math.max(0, Math.ceil(by0 - 0.5 - y0));
    const rEnd = Math.min(height - 1, Math.floor(by1 - 0.5 - y0));
    for (let r = rStart; r <= rEnd; r++) {
      const cy = y0 + r + 0.5;
      xs.length = 0;
      for (const ring of p.rings) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const [ax, ay] = ring[i]!;
          const [bx, by] = ring[(i + 1) % n]!;
          // half-open rule so a vertex on the scanline is counted once
          if ((ay <= cy) !== (by <= cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // pixel centre cx = x0 + c + 0.5 inside when xs[k] < cx < xs[k+1]
        const cA = Math.max(0, Math.floor(xs[k]! - 0.5 - x0) + 1);
        const cB = Math.min(width - 1, Math.ceil(xs[k + 1]! - 0.5 - x0) - 1);
        for (let c = cA; c <= cB; c++) {
          const i = r * width + c;
          const cur = out[i]!;
          out[i] = cur === NONE || cur === p.label ? p.label : CONFLICT;
        }
      }
    }
  }
  return out;
}

/** True when any model band is nodata or NaN at pixel index i. */
export function isNodata(tile: Tile, bands: number[], i: number): boolean {
  for (const b of bands) {
    const v = tile.bands[b - 1]![i]!;
    if (Number.isNaN(v) || v === tile.nodata) return true;
  }
  return false;
}
