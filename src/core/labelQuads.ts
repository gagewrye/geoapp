import { applyAffine, toLonLat } from "./crs";
import type { Window } from "./grid";
import { MAX_LAT, type Grid } from "./types";
import { mercator } from "./warp";

/** A band of a label tile and the lon/lat of its pixel-grid corners TL, TR, BR, BL (spec 018). */
export type Quad = { window: Window; corners: [number, number][] };

/** Largest bilinear placement error of a quad's pixels, in pixels (spec 018). */
export const QUAD_ERR = 0.05;

// Corners past this are pulled in so MapLibre gets finite Mercator; corners beyond MAX_LAT never show.
const POLE_LAT = 89.9;
// MAX_LAT as a Mercator y, so interpolated corners are tested without interpolating their latitude
const MAX_MY = mercator(0, MAX_LAT)[1];

/** Lattice step in pixels: corners between its nodes are interpolated, not projected (ADR 0023). */
export const LATTICE = 16;
/** Largest error of an interpolated lattice cell centre, in widths of its pixel, before the lattice halves. */
export const LATTICE_TOL = 0.005;

/**
 * Split w into 2^b column by 2^c row bands, fewest first (ties: more row bands), so that bilinear
 * interpolation of each band's corners in Mercator puts every pixel corner within maxErr of that
 * pixel's narrowest width of its true position (ADR 0019), checked on a projected lattice (ADR 0023). Row-major.
 */
export function tileQuads(grid: Grid, w: Window, maxErr: number): Quad[] {
  return latticeQuads(grid, w, maxErr, LATTICE).quads;
}

/** tileQuads starting from a lattice step; also gives the step the self-check settled on (1 projects every corner). */
export function latticeQuads(grid: Grid, w: Window, maxErr: number, lattice: number): { quads: Quad[]; lattice: number } {
  // corners one beyond the window too, so each corner's pixel width comes from the pixel it is the top left of
  const W = w.width + 2, H = w.height + 2;
  // Mercator only: lon/lat between nodes is never needed, as quad corners are projected exactly
  const mx = new Float64Array(W * H), my = new Float64Array(W * H);
  // exact projections, kept across lattice steps: a cell centre at one step is a node at the next
  const exLon = new Float64Array(W * H), exLat = new Float64Array(W * H), known = new Uint8Array(W * H);
  const exact = (i: number) => {
    if (!known[i]) {
      const c = i % W, [x, y] = toLonLat(grid.epsg, ...applyAffine(grid.gt, w.x0 + c, w.y0 + (i - c) / W));
      exLon[i] = x; exLat[i] = Math.max(-POLE_LAT, Math.min(POLE_LAT, y)); known[i] = 1;
    }
    return i;
  };
  let step = Math.max(1, Math.floor(lattice));
  for (;;) {
    const cols = cells(w.width, step), rows = cells(w.height, step);
    project(cols, rows);
    if (step === 1 || centresFit(cols, rows)) break;
    step = Math.max(1, Math.floor(step / 2));
  }

  /** Nodes projected exactly, every other corner's Mercator position bilinear in its lattice cell. */
  function project(cols: Cells, rows: Cells) {
    for (const r of rows.nodes) for (const c of cols.nodes) {
      const i = exact(r * W + c);
      [mx[i], my[i]] = mercator(exLon[i]!, exLat[i]!);
    }
    // bilinear as two linear passes: along node rows between nodes, then down each column between node rows
    for (const r of rows.nodes) for (let c = 0; c < W; c++) {
      const u = cols.t[c]!;
      if (u === 0) continue; // a node
      const i = r * W + c, k0 = r * W + cols.a[c]!, k1 = r * W + cols.b[c]!;
      mx[i] = (1 - u) * mx[k0]! + u * mx[k1]!;
      my[i] = (1 - u) * my[k0]! + u * my[k1]!;
    }
    for (let r = 0; r < H; r++) {
      const v = rows.t[r]!;
      if (v === 0) continue; // a node row
      const i0 = r * W, a0 = rows.a[r]! * W, b0 = rows.b[r]! * W;
      for (let c = 0; c < W; c++) {
        mx[i0 + c] = (1 - v) * mx[a0 + c]! + v * mx[b0 + c]!;
        my[i0 + c] = (1 - v) * my[a0 + c]! + v * my[b0 + c]!;
      }
    }
  }

  /** Each cell's centre corner, projected exactly, is within LATTICE_TOL of its pixel's narrowest width of its interpolation. */
  function centresFit(cols: Cells, rows: Cells): boolean {
    // the window's cells only: the last span on each side is the one-pixel ring beyond it
    for (let j = 0; j + 2 < rows.nodes.length; j++) for (let k = 0; k + 2 < cols.nodes.length; k++) {
      const r = (rows.nodes[j]! + rows.nodes[j + 1]!) >> 1, c = (cols.nodes[k]! + cols.nodes[k + 1]!) >> 1;
      if (r === rows.nodes[j] && c === cols.nodes[k]) continue; // a one-pixel cell: its centre is a node
      const i = exact(r * W + c);
      if (Math.abs(exLat[i]!) > MAX_LAT) continue; // never shows
      const [ex, ey] = mercator(exLon[i]!, exLat[i]!);
      const ax = mx[i + 1]! - mx[i]!, ay = my[i + 1]! - my[i]!, bx = mx[i + W]! - mx[i]!, by = my[i + W]! - my[i]!;
      const narrow = Math.abs(ax * by - ay * bx) / Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
      if (!(Math.hypot(mx[i]! - ex, my[i]! - ey) <= LATTICE_TOL * narrow)) return false;
    }
    return true;
  }

  // per corner, squared: maxErr x the narrowest width (area over longer edge) of its pixel; NaN beyond MAX_LAT, never checked
  const tol2 = new Float64Array(W * H);
  for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
    const i = r * W + c;
    const ax = mx[i + 1]! - mx[i]!, ay = my[i + 1]! - my[i]!, bx = mx[i + W]! - mx[i]!, by = my[i + W]! - my[i]!;
    const cross = maxErr * (ax * by - ay * bx);
    tol2[i] = Math.abs(my[i]!) <= MAX_MY ? (cross * cross) / Math.max(ax * ax + ay * ay, bx * bx + by * by) : NaN;
  }
  const edges = (n: number, k: number) => Array.from({ length: k + 1 }, (_, i) => Math.floor((i * n) / k));
  const fits = (xs: number[], ys: number[]) => {
    for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
      const cx0 = xs[i]!, cx1 = xs[i + 1]!, ry0 = ys[j]!, ry1 = ys[j + 1]!;
      const k = [ry0 * W + cx0, ry0 * W + cx1, ry1 * W + cx1, ry1 * W + cx0] as const;
      for (let r = ry0; r <= ry1; r++) {
        const v = (r - ry0) / (ry1 - ry0);
        for (let c = cx0; c <= cx1; c++) {
          const t = tol2[r * W + c]!;
          if (!(t >= 0)) continue;
          const u = (c - cx0) / (cx1 - cx0);
          const a = (1 - u) * (1 - v), b = u * (1 - v), d = u * v, e = (1 - u) * v;
          const ex = a * mx[k[0]]! + b * mx[k[1]]! + d * mx[k[2]]! + e * mx[k[3]]! - mx[r * W + c]!;
          const ey = a * my[k[0]]! + b * my[k[1]]! + d * my[k[2]]! + e * my[k[3]]! - my[r * W + c]!;
          if (ex * ex + ey * ey > t) return false;
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
    // projected exactly, so a quad's corners are footprintRing's (spec 018) whatever the lattice
    const corners = [ry0 * W + cx0, ry0 * W + cx1, ry1 * W + cx1, ry1 * W + cx0].map((k): [number, number] => [exLon[exact(k)]!, exLat[k]!]);
    out.push({ window: { x0: w.x0 + cx0, y0: w.y0 + ry0, width: cx1 - cx0, height: ry1 - ry0 }, corners });
  }
  return { quads: out, lattice: step };
}

/** Lattice nodes along one side of n pixels (every step, the last corner and the ring beyond), and per corner its cell and offset in it. */
type Cells = { nodes: number[]; a: Int32Array; b: Int32Array; t: Float64Array };
function cells(n: number, step: number): Cells {
  const nodes: number[] = [];
  for (let k = 0; k < n; k += step) nodes.push(k);
  nodes.push(n, n + 1);
  const a = new Int32Array(n + 2), b = new Int32Array(n + 2), t = new Float64Array(n + 2);
  for (let j = 0, c = 0; c < n + 2; c++) {
    while (j + 1 < nodes.length && nodes[j + 1]! <= c) j++;
    const lo = nodes[j]!, hi = c === lo ? lo : nodes[j + 1]!;
    a[c] = lo; b[c] = hi; t[c] = hi === lo ? 0 : (c - lo) / (hi - lo);
  }
  return { nodes, a, b, t };
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
