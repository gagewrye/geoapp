import { fromLonLat, invertAffine, applyAffine, toLonLat } from "./crs";
import type { Window } from "./grid";
import { MAX_LAT, type Affine, type Tile } from "./types";

const R = 6378137;
const D2R = Math.PI / 180;
const MERC_MAX_Y = R * Math.log(Math.tan(Math.PI / 4 + (MAX_LAT * D2R) / 2));
const EDGE_STEPS = 32;

const mercX = (lon: number) => R * lon * D2R;
const mercY = (lat: number) => Math.max(-MERC_MAX_Y, Math.min(MERC_MAX_Y, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))));
export const lonOf = (x: number) => x / R / D2R;
export const latOf = (y: number) => Math.atan(Math.sinh(y / R)) / D2R;

/** Mercator bbox [x0, y0, x1, y1] of a raster window's footprint, from densified edges. */
export function mercBounds(src: Window, gt: Affine, epsg: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let s = 0; s <= EDGE_STEPS; s++) {
    const t = s / EDGE_STEPS;
    const pts: [number, number][] = [[t * src.width, 0], [t * src.width, src.height], [0, t * src.height], [src.width, t * src.height]];
    for (const [c, r] of pts) {
      const [x, y] = applyAffine(gt, src.x0 + c, src.y0 + r);
      const [lon, lat] = toLonLat(epsg, x, y);
      const mx = mercX(lon), my = mercY(lat);
      x0 = Math.min(x0, mx); x1 = Math.max(x1, mx); y0 = Math.min(y0, my); y1 = Math.max(y1, my);
    }
  }
  return [x0, y0, x1, y1];
}

/** Axis-aligned Mercator grid over a window (longer side maxSide; corners TL, TR, BR, BL); `each` visits pixel centres. */
export function mercatorGrid(win: Window, gt: Affine, epsg: number, maxSide: number) {
  const [mx0, my0, mx1, my1] = mercBounds(win, gt, epsg);
  const aspect = (mx1 - mx0) / (my1 - my0);
  const width = aspect >= 1 ? maxSide : Math.max(1, Math.round(maxSide * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(maxSide / aspect)) : maxSide;
  const sx = (mx1 - mx0) / width;
  const sy = (my1 - my0) / height;
  const W = lonOf(mx0), E = lonOf(mx1), N = latOf(my1), S = latOf(my0);
  const corners: [number, number][] = [[W, N], [E, N], [E, S], [W, S]];
  const each = (f: (o: number, col: number, row: number) => void) => {
    for (let v = 0; v < height; v++) {
      const lat = latOf(my1 - (v + 0.5) * sy);
      for (let u = 0; u < width; u++) {
        const [x, y] = fromLonLat(epsg, lonOf(mx0 + (u + 0.5) * sx), lat);
        const [c, r] = invertAffine(gt, x, y);
        f(v * width + u, c, r);
      }
    }
  };
  return { width, height, corners, each };
}

/** Per-band [min, max] over valid pixels, for a linear 0..255 stretch. */
function ranges(src: Tile, nb: number): [number, number][] {
  return src.bands.slice(0, nb).map((a) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) if (!Number.isNaN(v) && v !== src.nodata) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
  });
}

/**
 * Warp a (decimated) tile onto an axis-aligned Mercator grid; corners are TL, TR, BR, BL lon/lat.
 * Each band is stretched over its own valid range unless `stretch` fixes one range for all.
 */
export function warpPreview(src: Tile, gt: Affine, epsg: number, maxSide: number, stretch?: [number, number]) {
  const nb = src.bands.length >= 3 ? 3 : 1;
  const rg = stretch ? Array.from({ length: nb }, () => stretch) : ranges(src, nb);
  const { width, height, corners, each } = mercatorGrid(src, gt, epsg, maxSide);
  const rgba = new Uint8ClampedArray(width * height * 4);
  each((g, c, r) => {
    const i = Math.floor(c - src.x0);
    const j = Math.floor(r - src.y0);
    if (!(i >= 0 && i < src.width && j >= 0 && j < src.height)) return;
    const p = j * src.width + i;
    const o = 4 * g;
    for (let k = 0; k < nb; k++) {
      const val = src.bands[k]![p]!;
      if (Number.isNaN(val) || val === src.nodata) return;
      const [lo, hi] = rg[k]!;
      rgba[o + k] = hi > lo ? ((val - lo) / (hi - lo)) * 255 : 0;
    }
    if (nb === 1) rgba[o + 1] = rgba[o + 2] = rgba[o]!;
    rgba[o + 3] = 255;
  });
  return { rgba, width, height, corners };
}
