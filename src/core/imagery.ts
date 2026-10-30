import { fromLonLat, invertAffine } from "./crs";
import { decimatedAffine } from "./decimate";
import type { Window } from "./grid";
import { QUAD_ERR, tileQuads, type Quad } from "./labelQuads";
import { MAX_LAT, TILE_SIZE, type Grid } from "./types";
import { latOf, mercator } from "./warp";

/** Spec 020: tiles kept (LRU), the coarsest step sampled from full resolution, and the block and read limits. */
export const IMAGERY_TILES = 512, MAX_DECIMATE = 4, MAX_BLOCK_BYTES = 16 * 2 ** 20, MAX_READ_BYTES = 16 * 2 ** 20;
/** Spec 028: geotiff decodes a read in one task, so tile and mask reads through it decode at most this much each. */
export const TASK_READ_BYTES = 4 * 2 ** 20;

/** A reduced-resolution IFD of the file: its index in the TIFF, its size, and its block when known (reads are bounded by it). */
export type Overview = { index: number; width: number; height: number; block?: Block };
/** A TIFF tile or strip; bytes are all its samples decoded. */
export type Block = { width: number; height: number; bytes: number };
/** One texel stands for s x s source pixels; overview null samples full resolution. */
export type Level = { s: number; grid: Grid; overview: number | null };

const EDGE_STEPS = 16;
// an overview counts as level s when its size is within this fraction of W/s and H/s
const SIZE_TOL = 0.01;

/** Raster pixel coordinates of the view's edges, densified; bounds are [w, s, e, n] lon/lat. Points that don't project are skipped. */
function viewRing(full: Grid, [w, s, e, n]: [number, number, number, number]): [number, number][] {
  const ys = mercator(0, Math.max(-MAX_LAT, s))[1], yn = mercator(0, Math.min(MAX_LAT, n))[1];
  const pts: [number, number][] = [];
  const at = (u: number, v: number) => [w + (e - w) * u, latOf(yn + (ys - yn) * v)] as const; // the view is a Mercator rectangle
  for (let i = 0; i < 4 * EDGE_STEPS; i++) {
    const side = Math.floor(i / EDGE_STEPS), t = (i % EDGE_STEPS) / EDGE_STEPS;
    const [lon, lat] = side === 0 ? at(t, 0) : side === 1 ? at(1, t) : side === 2 ? at(1 - t, 1) : at(0, 1 - t);
    const [c, r] = invertAffine(full.gt, ...fromLonLat(full.epsg, lon, lat));
    if (Number.isFinite(c) && Number.isFinite(r)) pts.push([c, r]);
  }
  return pts;
}

/** The level at step s: a matching overview, else full resolution for s <= MAX_DECIMATE, else null. */
function levelAt(full: Grid, overviews: Overview[], s: number): Level | null {
  if (s === 1) return { s, grid: full, overview: null };
  const tw = full.width / s, th = full.height / s;
  const near = overviews.filter((o) => Math.abs(o.width - tw) <= SIZE_TOL * tw && Math.abs(o.height - th) <= SIZE_TOL * th)
    .sort((a, b) => Math.abs(a.width - tw) - Math.abs(b.width - tw));
  const o = near[0];
  if (o) {
    const fx = full.width / o.width, fy = full.height / o.height, g = full.gt;
    return { s, overview: o.index, grid: { ...full, width: o.width, height: o.height, gt: [g[0], g[1] * fx, g[2] * fy, g[3], g[4] * fx, g[5] * fy] } };
  }
  if (s > MAX_DECIMATE) return null;
  return { s, overview: null, grid: { ...full, width: Math.ceil(full.width / s), height: Math.ceil(full.height / s), gt: decimatedAffine(full.gt, s) } };
}

/** 256-aligned tiles of a grid of size lw x lh over the full-resolution pixel box [x0, x1) x [y0, y1). */
function tilesOver(lw: number, lh: number, kx: number, ky: number, [x0, y0, x1, y1]: number[]): Window[] {
  const out: Window[] = [];
  const lx0 = Math.floor(x0! * kx), ly0 = Math.floor(y0! * ky), lx1 = Math.min(lw, Math.ceil(x1! * kx)), ly1 = Math.min(lh, Math.ceil(y1! * ky));
  for (let y = Math.floor(ly0 / TILE_SIZE) * TILE_SIZE; y < ly1; y += TILE_SIZE)
    for (let x = Math.floor(lx0 / TILE_SIZE) * TILE_SIZE; x < lx1; x += TILE_SIZE)
      out.push({ x0: x, y0: y, width: Math.min(TILE_SIZE, lw - x), height: Math.min(TILE_SIZE, lh - y) });
  return out;
}

/**
 * The level and the tiles (centre first) to draw for a view of cssW x cssH CSS pixels with lon/lat bounds [w, s, e, n];
 * null when no level can show it (the preview alone does).
 */
export function planView(full: Grid, overviews: Overview[], bounds: [number, number, number, number], cssW: number, cssH: number): { level: Level; tiles: Window[] } | null {
  const ring = viewRing(full, bounds);
  if (ring.length < 3) return null;
  let area = 0;
  ring.forEach(([x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]!; area += x * ny - nx * y; });
  // source pixels per CSS pixel, by area so rotation and shear don't inflate it
  const density = Math.sqrt(Math.abs(area) / 2 / (cssW * cssH));
  if (!(density > 0) || !Number.isFinite(density)) return null;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const box = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))),
    Math.min(full.width, Math.ceil(Math.max(...xs))), Math.min(full.height, Math.ceil(Math.max(...ys)))];
  const on = box[0]! < box[2]! && box[1]! < box[3]!;
  // the tolerance keeps an exact power of two from rounding down a level
  for (let s = 2 ** Math.max(0, Math.floor(Math.log2(density) + 1e-9)); ; s *= 2) {
    const level = levelAt(full, overviews, s);
    const lw = level?.grid.width ?? Math.ceil(full.width / s), lh = level?.grid.height ?? Math.ceil(full.height / s);
    const kx = lw / full.width, ky = lh / full.height;
    const tiles = on ? tilesOver(lw, lh, kx, ky, box) : [];
    if (tiles.length > IMAGERY_TILES / 2) continue;
    if (!level) return null;
    const cx = ((box[0]! + box[2]!) / 2) * kx, cy = ((box[1]! + box[3]!) / 2) * ky;
    const dist = (t: Window) => Math.hypot(t.x0 + t.width / 2 - cx, t.y0 + t.height / 2 - cy);
    return { level, tiles: tiles.sort((a, b) => dist(a) - dist(b)) };
  }
}

/** One raster's imagery quads by `${level.s}:${key}` (spec 026): corners only, so an evicted tile doesn't project them again. */
export type QuadCache = Map<string, Quad[]>;

/** A level tile's quads: at s = 1, the label overlay's quads for the same key (ADR 0019); from `cache` when given and known. */
export function imageryQuads(level: Level, tile: Window, cache?: QuadCache, key?: string): Quad[] {
  const k = cache && key !== undefined ? `${level.s}:${key}` : null;
  const known = k === null ? undefined : cache!.get(k);
  if (known) return known;
  const quads = tileQuads(level.grid, tile, QUAD_ERR);
  if (k !== null) cache!.set(k, quads);
  return quads;
}

/** Decoded bytes of the blocks a window of a width x height image touches: geotiff decodes all of them for one read. */
export function decodedBytes(w: Window, block: Block, width: number, height: number): number {
  const x1 = Math.min(w.x0 + w.width, width), y1 = Math.min(w.y0 + w.height, height);
  if (x1 <= w.x0 || y1 <= w.y0) return 0;
  const nx = Math.ceil(x1 / block.width) - Math.floor(w.x0 / block.width), ny = Math.ceil(y1 / block.height) - Math.floor(w.y0 / block.height);
  return nx * ny * block.bytes;
}

/**
 * Windows of a width x height image covering the tiles, with s the step from texels to the pixels read (1 for an overview):
 * each row's contiguous tiles as one window, clipped to the image, split in block-aligned rows and columns
 * so that each read decodes at most `cap` bytes: MAX_READ_BYTES (spec 020 A1), or TASK_READ_BYTES for a task's read (spec 028).
 */
export function rowReads(tiles: Window[], s: number, block: Block, width: number, height: number, cap = MAX_READ_BYTES): Window[] {
  const sorted = [...tiles].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows: Window[] = [];
  let cur: Window | null = null;
  for (const t of sorted) {
    const w = { x0: t.x0 * s, y0: t.y0 * s, width: t.width * s, height: t.height * s };
    if (cur && cur.y0 === w.y0 && cur.x0 + cur.width === w.x0) cur.width += w.width;
    else rows.push((cur = w));
  }
  return rows.flatMap((w) => {
    // a partial last texel's span may pass the edge; it samples the last pixel (decimateInto clamps)
    const c = { ...w, width: Math.min(w.width, width - w.x0), height: Math.min(w.height, height - w.y0) };
    return c.width > 0 && c.height > 0 ? splitByBlocks(c, block, cap) : [];
  });
}

/** Split a window at block edges into reads of at most `cap` bytes of blocks: whole block rows first, else columns too. */
function splitByBlocks(w: Window, { width: bw, height: bh, bytes }: Block, cap: number): Window[] {
  const bx0 = Math.floor(w.x0 / bw), bx1 = Math.ceil((w.x0 + w.width) / bw);
  const by0 = Math.floor(w.y0 / bh), by1 = Math.ceil((w.y0 + w.height) / bh);
  const nx = bx1 - bx0, ny = by1 - by0;
  const per = Math.max(1, Math.floor(cap / bytes)); // a block over the limit is read alone
  const [kx, ky] = nx * ny <= per ? [nx, ny] : nx <= per ? [nx, Math.floor(per / nx)] : [per, 1];
  const out: Window[] = [];
  for (let by = by0; by < by1; by += ky) for (let bx = bx0; bx < bx1; bx += kx) {
    const x0 = Math.max(w.x0, bx * bw), x1 = Math.min(w.x0 + w.width, (bx + kx) * bw);
    const y0 = Math.max(w.y0, by * bh), y1 = Math.min(w.y0 + w.height, (by + ky) * bh);
    out.push({ x0, y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}

/** Per axis, the [first, last] sampled index (i*f + floor(f/2), clamped) in each block holding one; null for blocks with none. */
function sampledSpans(size: number, block: number, f: number): ([number, number] | null)[] {
  const spans: ([number, number] | null)[] = Array.from({ length: Math.ceil(size / block) }, () => null);
  for (let i = 0; i * f < size; i++) {
    const p = Math.min(i * f + Math.floor(f / 2), size - 1), b = Math.floor(p / block);
    const sp = spans[b];
    spans[b] = sp ? [sp[0], p] : [p, p];
  }
  return spans;
}

/** The blocks of a width x height image holding a pixel sampled at step f, each cropped to its sampled span, row-major. */
export function blockWindows(width: number, height: number, blockW: number, blockH: number, f: number): Window[] {
  const cols = sampledSpans(width, blockW, f), rows = sampledSpans(height, blockH, f);
  const out: Window[] = [];
  for (const r of rows) for (const c of cols) if (r && c) out.push({ x0: c[0], y0: r[0], width: c[1] - c[0] + 1, height: r[1] - r[0] + 1 });
  return out;
}

/**
 * n pixels of 1 or 3 bands to RGBA with warpPreview's per-band linear stretch; NaN, nodata or alpha 0 (bands[alpha]) gives alpha 0.
 * Values are rounded to float32 first, as readWindow's bands and nodata are.
 */
export function toRgba(bands: ArrayLike<number>[], n: number, ranges: [number, number][], nodata: number | null, out: Uint8ClampedArray, alpha: number | null = null): void {
  const nb = (alpha ?? bands.length) >= 3 ? 3 : 1;
  const a = alpha === null ? undefined : bands[alpha];
  for (let p = 0; p < n; p++) {
    const o = 4 * p;
    let ok = a?.[p] !== 0; // spec 022 rule A: any other alpha is opaque
    for (let k = 0; ok && k < nb; k++) {
      const v = Math.fround(bands[k]![p]!);
      if (Number.isNaN(v) || v === nodata) { ok = false; break; }
      const [lo, hi] = ranges[k]!;
      out[o + k] = hi > lo ? ((v - lo) / (hi - lo)) * 255 : 0;
    }
    if (!ok) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
    if (nb === 1) out[o + 1] = out[o + 2] = out[o]!;
    out[o + 3] = 255;
  }
}
