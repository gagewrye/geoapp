import type { Window } from "./grid";
import { maskBit } from "./nodata";
import { TILE_SIZE } from "./types";

/** At most 256 label tiles (16 MiB) in memory (ADR 0010). */
export const MAX_LABEL_TILES = 256;

/** Painted labels on the source grid: 0 = unlabelled, else class index + 1. */
// Keys are `${x0},${y0}` of tileWindows() windows; tiles are row-major and window-sized. base: a mask is
// loaded (spec 014), shown where a key is absent; a stored tile overrides it whole, so with base an emptied
// or all-zero tile is kept (it hides the mask), and without base none is kept.
export type LabelStore = { width: number; height: number; tiles: Map<string, Uint8Array>; base: boolean };
/** Imagery-nodata masks (nodataMask) by LabelStore key. */
export type NodataMasks = Map<string, Uint8Array>;

export const emptyStore = (width: number, height: number): LabelStore => ({ width, height, tiles: new Map(), base: false });

/** The tileWindows() window whose origin is (x0, y0), clipped to the raster. */
export function tileWindow(dims: { width: number; height: number }, x0: number, y0: number): Window {
  return { x0, y0, width: Math.min(TILE_SIZE, dims.width - x0), height: Math.min(TILE_SIZE, dims.height - y0) };
}

const origin = (key: string): [number, number] => key.split(",").map(Number) as [number, number];

/** Keys of the tile windows that w meets, row-major. */
export function tileKeys(w: Window): string[] {
  const keys: string[] = [];
  for (let y = Math.floor(w.y0 / TILE_SIZE) * TILE_SIZE; y < w.y0 + w.height; y += TILE_SIZE)
    for (let x = Math.floor(w.x0 / TILE_SIZE) * TILE_SIZE; x < w.x0 + w.width; x += TILE_SIZE) keys.push(`${x},${y}`);
  return keys;
}

/** Calls f(tileIndex) for every pixel of w inside tile window t. */
function eachPixel(t: Window, w: Window, f: (i: number) => void): void {
  const x0 = Math.max(t.x0, w.x0), x1 = Math.min(t.x0 + t.width, w.x0 + w.width);
  const y0 = Math.max(t.y0, w.y0), y1 = Math.min(t.y0 + t.height, w.y0 + w.height);
  for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) f((r - t.y0) * t.width + (c - t.x0));
}

function isEmpty(tile: Uint8Array): boolean {
  // erase checks after every cell, so compare four bytes at a time
  const n4 = tile.byteOffset % 4 === 0 ? tile.length >> 2 : 0;
  const words = new Uint32Array(tile.buffer, tile.byteOffset, n4);
  for (let i = 0; i < n4; i++) if (words[i]) return false;
  for (let i = n4 * 4; i < tile.length; i++) if (tile[i]) return false;
  return true;
}

/** Paint w (mask bit 0 pixels only; throws on a missing mask) or erase value in w (an emptied tile goes unless store.base); "full" changes nothing. */
export function brush(store: LabelStore, masks: NodataMasks, w: Window, value: number, erase: boolean): "ok" | "full" {
  if (!Number.isInteger(value) || value < 1 || value > 255) throw new Error(`brush: label value ${value} is not 1..255`);
  const keys = tileKeys(w);
  if (erase) {
    for (const key of keys) {
      const tile = store.tiles.get(key);
      if (!tile) continue;
      let cleared = false;
      eachPixel(tileWindow(store, ...origin(key)), w, (i) => { if (tile[i] === value) { tile[i] = 0; cleared = true; } });
      if (cleared && !store.base && isEmpty(tile)) store.tiles.delete(key);
    }
    return "ok";
  }
  // plan first, so a missing mask or the cap changes nothing
  const plan = keys.map((key) => {
    const mask = masks.get(key);
    if (!mask) throw new Error(`brush: no nodata mask for tile ${key}`);
    const t = tileWindow(store, ...origin(key));
    let labels = false;
    if (!store.tiles.has(key)) eachPixel(t, w, (i) => { if (!maskBit(mask, i)) labels = true; });
    return { key, mask, t, create: labels };
  });
  if (store.tiles.size + plan.filter((p) => p.create).length > MAX_LABEL_TILES) return "full";
  for (const { key, mask, t, create } of plan) {
    const tile = store.tiles.get(key) ?? (create ? new Uint8Array(t.width * t.height) : undefined);
    if (!tile) continue;
    eachPixel(t, w, (i) => { if (!maskBit(mask, i)) tile[i] = value; });
    if (create) store.tiles.set(key, tile);
  }
  return "ok";
}

/** Deletes the masks of tiles that are neither stored nor met by w (null: met by nothing). */
export function keepMasks(store: LabelStore, masks: NodataMasks, w: Window | null): void {
  const met = new Set(w ? tileKeys(w) : []);
  for (const key of [...masks.keys()]) if (!store.tiles.has(key) && !met.has(key)) masks.delete(key);
}

/** Replaces w's tile with window-sized labels; all zeros deletes it unless store.base; "full" (a new key at the cap) changes nothing. */
export function putTile(store: LabelStore, w: Window, labels: Uint8Array): "ok" | "full" {
  if (labels.length !== w.width * w.height) throw new Error(`putTile: ${labels.length} labels for a ${w.width}x${w.height} window`);
  const key = `${w.x0},${w.y0}`;
  if (!store.base && isEmpty(labels)) { store.tiles.delete(key); return "ok"; }
  if (!store.tiles.has(key) && store.tiles.size >= MAX_LABEL_TILES) return "full";
  store.tiles.set(key, labels);
  return "ok";
}
