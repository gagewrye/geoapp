import { maskBit } from "./nodata";

/** Cached mask arrays stay within this many bytes; past it the least recently used go first (ADR 0021). */
export const MASK_BYTES = 256 * 2 ** 20;

/** A window's imagery mask (spec 023): bits as nodataMask (1 = nodata), or "all" valid / "none" valid with no array. */
export type ValidMask = Uint8Array | "all" | "none";

/** The bits of n pixels as a ValidMask: "all" or "none" when uniform, else the bits themselves. */
export function compactMask(bits: Uint8Array, n: number): ValidMask {
  const full = n >> 3, rest = n & 7;
  let any = false, every = true;
  for (let i = 0; i < full; i++) { const b = bits[i]!; if (b) any = true; if (b !== 255) every = false; }
  if (rest) {
    const b = bits[full]! & ((1 << rest) - 1);
    if (b) any = true;
    if (b !== (1 << rest) - 1) every = false;
  }
  return !any ? "all" : every ? "none" : bits;
}

/** Pixel i of the window is valid imagery (may take a label). */
export const validAt = (mask: ValidMask, i: number): boolean => (mask === "all" ? true : mask === "none" ? false : !maskBit(mask, i));

/** labels[i] = 0 where the mask says nodata. */
export function maskLabels(mask: ValidMask, labels: Uint8Array): void {
  if (mask === "all") return;
  if (mask === "none") { labels.fill(0); return; }
  for (let i = 0; i < labels.length; i++) if (maskBit(mask, i)) labels[i] = 0;
}

/** Band indices, centre first, then alternately below (higher index) and above, each once. */
export function bandOrder(bands: number, centre: number): number[] {
  if (bands <= 0) return [];
  const c = Math.max(0, Math.min(bands - 1, centre));
  const out = [c];
  for (let d = 1; out.length < bands; d++) {
    if (c + d < bands) out.push(c + d);
    if (c - d >= 0) out.push(c - d);
  }
  return out;
}

/** Window masks by LabelStore key, kept for the raster's life; arrays past maxBytes go least recently used first. */
// Map order is recency: get() and set() move a key to the end. Uniform masks hold no array and are never dropped.
export class MaskStore {
  private readonly masks = new Map<string, ValidMask>();
  private arrayBytes = 0;

  constructor(private readonly maxBytes = MASK_BYTES) {}

  get size(): number { return this.masks.size; }
  /** Bytes of mask arrays held. */
  get bytes(): number { return this.arrayBytes; }
  keys(): IterableIterator<string> { return this.masks.keys(); }
  has(key: string): boolean { return this.masks.has(key); }

  get(key: string): ValidMask | undefined {
    const m = this.masks.get(key);
    if (m === undefined || typeof m === "string") return m;
    this.masks.delete(key);
    this.masks.set(key, m);
    return m;
  }

  set(key: string, mask: ValidMask): void {
    this.delete(key);
    this.masks.set(key, mask);
    if (typeof mask === "string") return;
    this.arrayBytes += mask.byteLength;
    for (const [k, m] of this.masks) {
      if (this.arrayBytes <= this.maxBytes) break;
      if (typeof m !== "string" && k !== key) this.delete(k);
    }
  }

  clear(): void { this.masks.clear(); this.arrayBytes = 0; }

  private delete(key: string): void {
    const m = this.masks.get(key);
    if (m !== undefined && typeof m !== "string") this.arrayBytes -= m.byteLength;
    this.masks.delete(key);
  }
}
