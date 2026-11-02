import { TILE_SIZE } from "./types";

/** Tiles with full-resolution label overlays at once (ADR 0033); the rest show on the mask preview. */
export const LABEL_OVERLAYS = 256;

/**
 * Keys whose tile window meets box [x0, y0, x1, y1] (raster px, x1/y1 exclusive), nearest tile centre to the
 * box centre first, ties row-major, at most max. A tile's centre is its unclipped 256 px window's.
 */
export function overlayKeys(keys: Iterable<string>, box: [number, number, number, number], max: number): string[] {
  const [bx0, by0, bx1, by1] = box;
  if (!(bx0 < bx1 && by0 < by1)) return [];
  // doubled coordinates keep the half-pixel box centre whole, so distances compare exactly
  const cx = bx0 + bx1, cy = by0 + by1, half = TILE_SIZE / 2;
  const hits: { key: string; x: number; y: number; d: number }[] = [];
  for (const key of keys) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    if (x >= bx1 || x + TILE_SIZE <= bx0 || y >= by1 || y + TILE_SIZE <= by0) continue;
    hits.push({ key, x, y, d: (2 * (x + half) - cx) ** 2 + (2 * (y + half) - cy) ** 2 });
  }
  hits.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return hits.slice(0, max).map((h) => h.key);
}
