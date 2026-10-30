import { maskBit } from "./nodata";
import type { ValidMask } from "./validMask";

/**
 * One import pass's counts of raw file values (spec 024): hist over every kept pixel, present as 256 bits per seed
 * window, and seen, the values met before imagery masking (spec 004's pass 1 took classes from those).
 */
export type RawCounts = { hist: Float64Array; present: Uint8Array; seen: Uint8Array };

export const rawCounts = (windows: number): RawCounts => ({ hist: new Float64Array(256), present: new Uint8Array(32 * windows), seen: new Uint8Array(256) });

/** vals[i] = -1 (no label) where the valid mask says imagery nodata. */
export function maskVals(mask: ValidMask, vals: Int16Array): void {
  if (mask === "all") return;
  if (mask === "none") { vals.fill(-1); return; }
  for (let i = 0; i < vals.length; i++) if (maskBit(mask, i)) vals[i] = -1;
}

/** Adds seed window wi's kept values (>= 0) to hist and its present bits. */
export function countRaw(vals: Int16Array, counts: RawCounts, wi: number): void {
  const { hist, present } = counts, o = 32 * wi;
  for (const v of vals) if (v >= 0) { hist[v]!++; present[o + (v >> 3)]! |= 1 << (v & 7); }
}

/**
 * What spec 004's labelling pass gave, from raw counts and the LUT: labelled pixels, the seed windows (indices) holding
 * one, the label values used, and the preview remapped (previewRaw: 0 none, else raw value + 1).
 */
// A preview pixel lies in one window, so a window with no labelled value maps all its preview pixels to 0 anyway.
export function finishImport(counts: RawCounts, lut: Uint8Array, previewRaw: Uint16Array): { count: number; labelled: number[]; classCount: number; preview: Uint8Array } {
  let count = 0;
  const used = new Set<number>();
  for (let v = 0; v < 256; v++) if (lut[v] && counts.hist[v]) { count += counts.hist[v]!; used.add(lut[v]!); }
  const labelled: number[] = [];
  for (let wi = 0; wi < counts.present.length / 32; wi++) {
    for (let v = 0; v < 256; v++) if (lut[v] && counts.present[32 * wi + (v >> 3)]! & (1 << (v & 7))) { labelled.push(wi); break; }
  }
  const preview = new Uint8Array(previewRaw.length);
  for (let i = 0; i < preview.length; i++) { const r = previewRaw[i]!; if (r) preview[i] = lut[r - 1]!; }
  return { count, labelled, classCount: used.size, preview };
}
