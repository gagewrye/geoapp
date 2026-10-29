import { applyAffine, toLonLat } from "./crs";
import type { Window } from "./grid";
import { MAX_LAT, type Grid } from "./types";
import { mercator } from "./warp";

/** A band of a label tile and the lon/lat of its pixel-grid corners TL, TR, BR, BL (spec 018). */
export type Quad = { window: Window; corners: [number, number][] };

// Corners past this are pulled in so MapLibre gets finite Mercator; corners beyond MAX_LAT never show.
const POLE_LAT = 89.9;

/**
 * Split w into 2^b column by 2^c row bands, fewest first (ties: more row bands), so that bilinear
 * interpolation of each band's corners in Mercator puts every pixel corner within maxErr of that
 * pixel's narrowest width of its true position (ADR 0019). Row-major.
 */
export function tileQuads(grid: Grid, w: Window, maxErr: number): Quad[] {
  // corners one beyond the window too, so each corner's pixel width comes from the pixel it is the top left of
  const W = w.width + 2, H = w.height + 2;
  const lon = new Float64Array(W * H), lat = new Float64Array(W * H), mx = new Float64Array(W * H), my = new Float64Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    const [x, y] = toLonLat(grid.epsg, ...applyAffine(grid.gt, w.x0 + c, w.y0 + r));
    lon[i] = x; lat[i] = Math.max(-POLE_LAT, Math.min(POLE_LAT, y));
    [mx[i], my[i]] = mercator(lon[i]!, lat[i]!);
  }
  // per corner: maxErr x the narrowest width (area over longer edge) of its pixel; NaN beyond MAX_LAT, never checked
  const tol = new Float64Array(W * H);
  for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
    const i = r * W + c;
    const ax = mx[i + 1]! - mx[i]!, ay = my[i + 1]! - my[i]!, bx = mx[i + W]! - mx[i]!, by = my[i + W]! - my[i]!;
    const cross = Math.abs(ax * by - ay * bx);
    tol[i] = Math.abs(lat[i]!) <= MAX_LAT ? (maxErr * cross) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by)) : NaN;
  }
  const edges = (n: number, k: number) => Array.from({ length: k + 1 }, (_, i) => Math.floor((i * n) / k));
  const fits = (xs: number[], ys: number[]) => {
    for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
      const cx0 = xs[i]!, cx1 = xs[i + 1]!, ry0 = ys[j]!, ry1 = ys[j + 1]!;
      const k = [ry0 * W + cx0, ry0 * W + cx1, ry1 * W + cx1, ry1 * W + cx0] as const;
      for (let r = ry0; r <= ry1; r++) {
        const v = (r - ry0) / (ry1 - ry0);
        for (let c = cx0; c <= cx1; c++) {
          const t = tol[r * W + c]!;
          if (!(t >= 0)) continue;
          const u = (c - cx0) / (cx1 - cx0);
          const a = (1 - u) * (1 - v), b = u * (1 - v), d = u * v, e = (1 - u) * v;
          const ex = a * mx[k[0]]! + b * mx[k[1]]! + d * mx[k[2]]! + e * mx[k[3]]! - mx[r * W + c]!;
          const ey = a * my[k[0]]! + b * my[k[1]]! + d * my[k[2]]! + e * my[k[3]]! - my[r * W + c]!;
          if (Math.hypot(ex, ey) > t) return false;
        }
      }
    }
    return true;
  };
  const bMax = Math.floor(Math.log2(w.width)), cMax = Math.floor(Math.log2(w.height));
  let xs = edges(w.width, 2 ** bMax), ys = edges(w.height, 2 ** cMax); // one-pixel bands are exact
  search: for (let s = 0; s < bMax + cMax; s++) {
    for (let c = Math.min(s, cMax); c >= 0 && s - c <= bMax; c--) {
      const bx = edges(w.width, 2 ** (s - c)), by = edges(w.height, 2 ** c);
      if (fits(bx, by)) { xs = bx; ys = by; break search; }
    }
  }
  const out: Quad[] = [];
  for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
    const cx0 = xs[i]!, cx1 = xs[i + 1]!, ry0 = ys[j]!, ry1 = ys[j + 1]!;
    const corners = [ry0 * W + cx0, ry0 * W + cx1, ry1 * W + cx1, ry1 * W + cx0].map((k): [number, number] => [lon[k]!, lat[k]!]);
    out.push({ window: { x0: w.x0 + cx0, y0: w.y0 + ry0, width: cx1 - cx0, height: ry1 - ry0 }, corners });
  }
  return out;
}

/** One texel per pixel: label v > 0 gets colours[v - 1] ("#rrggbb") at alpha 255; 0, or a value with no class, is transparent. */
export function paintLabels(labels: Uint8Array, colours: string[], rgba: Uint8ClampedArray): void {
  const rgb = colours.map((c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)));
  for (let p = 0; p < labels.length; p++) {
    const v = labels[p]!, o = 4 * p;
    const col = v > 0 ? rgb[v - 1] : undefined;
    if (!col) { rgba[o] = rgba[o + 1] = rgba[o + 2] = rgba[o + 3] = 0; continue; }
    rgba[o] = col[0]!; rgba[o + 1] = col[1]!; rgba[o + 2] = col[2]!; rgba[o + 3] = 255;
  }
}
