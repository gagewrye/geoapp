import { edgeSeeds, fillTile, inReach } from "../core/fill";
import type { Window } from "../core/grid";
import { tileWindow, type LabelStore } from "../core/labelStore";
import { maskSpans } from "../core/smart";
import type { Span } from "../core/spans";
import { TILE_SIZE } from "../core/types";
import { validAt, type ValidMask } from "../core/validMask";
import { maskedBaseTile, type MaskBase } from "./maskBase";
import { STROKE, type MaskCache } from "./maskCache";
import type { RasterSource } from "./source";

/** One tile as a fill sees it: its effective labels (null: none, so all 0) and its valid mask. */
export type FillTile = { labels: Uint8Array | null; mask: ValidMask };
export type FillRead = (key: string, t: Window) => Promise<FillTile>;
/** A fill's region as spans with its pixel count, the label value it had, and whether it reached FILL_REACH (so may go on past it). */
export type FillResult = { spans: Span[]; pixels: number; target: number; clipped: boolean };

/** The region a fill of `value` from `cell` covers (spec 054); "nodata": the cell has no imagery; "same": it already holds `value`; null: `stop` turned true after a read. */
// The valid pixels 4-connected to the cell that share its label, read tile by tile as the fill reaches them, within FILL_REACH.
export async function floodFill(dims: { width: number; height: number }, cell: [number, number], value: number, read: FillRead,
  stop: () => boolean = () => false): Promise<FillResult | "nodata" | "same" | null> {
  const [col, row] = cell;
  const tiles = new Map<string, FillTile & { t: Window; bits: Uint8Array }>();
  const load = async (key: string) => {
    if (tiles.has(key)) return;
    const [x0, y0] = key.split(",").map(Number) as [number, number], t = tileWindow(dims, x0, y0);
    tiles.set(key, { ...(await read(key, t)), t, bits: new Uint8Array(t.width * t.height) });
  };
  const key0 = `${Math.floor(col / TILE_SIZE) * TILE_SIZE},${Math.floor(row / TILE_SIZE) * TILE_SIZE}`;
  await load(key0);
  if (stop()) return null;
  const first = tiles.get(key0)!, i0 = (row - first.t.y0) * first.t.width + (col - first.t.x0);
  if (!validAt(first.mask, i0)) return "nodata";
  const target = first.labels ? first.labels[i0]! : 0;
  if (target === value) return "same";

  // Each round reads the tiles the fill just entered together, then spreads in them; a tile entered again later keeps its bits
  let pending = new Map<string, number[]>([[key0, [i0]]]), clipped = false;
  while (pending.size) {
    const round = pending;
    pending = new Map();
    await Promise.all([...round.keys()].map(load));
    if (stop()) return null;
    for (const [key, seeds] of round) {
      const { labels, mask, t, bits } = tiles.get(key)!;
      for (const next of edgeSeeds(dims, t, fillTile(labels, mask, t, target, bits, seeds))) {
        // the fill reached the limit; whether the region goes on past it would take reading the tiles beyond
        if (!inReach(cell, next.t.x0, next.t.y0)) { clipped = true; continue; }
        const k = `${next.t.x0},${next.t.y0}`, list = pending.get(k);
        if (list) list.push(...next.seeds); else pending.set(k, next.seeds);
      }
    }
  }
  const spans: Span[] = [];
  let pixels = 0;
  for (const { t, bits } of tiles.values()) for (const s of maskSpans(bits, t)) { spans.push(s); pixels += s.x1 - s.x0; }
  return { spans, pixels, target, clipped };
}

/** A fill's reads of the open raster: the stored tile, else the mask base's (masked by the cached valid mask), else none. */
export const fillReader = (imagery: RasterSource, store: LabelStore, base: MaskBase | null, cache: MaskCache): FillRead => async (key, t) => {
  let mask = cache.get(key);
  // as the paint queue does: other reads could evict it again each time, so fail rather than loop
  for (let tries = 0; mask === undefined; tries++) {
    if (tries === 2) throw new Error(`The valid mask of tile ${key} was evicted before it could be used`);
    await cache.need(t.y0, STROKE, [t.x0]);
    mask = cache.get(key);
  }
  const stored = store.tiles.get(key);
  return { labels: stored ?? (base && store.base ? await maskedBaseTile(imagery, base, t, mask) : null), mask };
};
