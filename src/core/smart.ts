import type { Window } from "./grid";
import type { Span } from "./spans";

/** Smart select's windows, encoder input and masks (spec 046, ADR 0032). */

/** The SAM encoder's input side, in pixels. */
export const SAM_SIDE = 1024;

// ImageNet mean and std, which SAM 2.1's image processor normalises with
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/** The window a prompt's first point fixes: SAM_SIDE square (or the raster's side), on 256 px steps, about centred on the cell. */
export function samWindow(dims: { width: number; height: number }, col: number, row: number): Window {
  const at = (c: number, side: number) => Math.min(Math.max(256 * Math.round((c - SAM_SIDE / 2) / 256), 0), Math.max(0, side - SAM_SIDE)) || 0;
  return { x0: at(col, dims.width), y0: at(row, dims.height), width: Math.min(SAM_SIDE, dims.width), height: Math.min(SAM_SIDE, dims.height) };
}

/** The encoder tensor, 1x3xSAM_SIDE² CHW, from w x h RGBA: normalised RGB; alpha-0 pixels and padding are 0. */
export function samInput(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const plane = SAM_SIDE * SAM_SIDE, out = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = 4 * (y * w + x);
    if (rgba[p + 3] === 0) continue;
    for (let c = 0; c < 3; c++) out[c * plane + y * SAM_SIDE + x] = (rgba[p + c]! / 255 - MEAN[c]!) / STD[c]!;
  }
  return out;
}

/** Raster cells as x, y pairs in encoder pixels: each cell's centre less the window's origin. */
export function promptPoints(points: [number, number][], w: Window): Float32Array {
  return Float32Array.from(points.flatMap(([c, r]) => [c + 0.5 - w.x0, r + 0.5 - w.y0]));
}

/** Stability below which a mask is passed over: SAM's own threshold for its automatic masks. */
export const STABLE = 0.9;

/** SAM's stability score: logits > offset over logits > -offset; 0 when none exceed -offset. */
export function stability(logits: Float32Array, offset = 1): number {
  let hi = 0, lo = 0;
  for (const v of logits) {
    if (v > offset) hi++;
    if (v > -offset) lo++;
  }
  return lo === 0 ? 0 : hi / lo;
}

/** The share of logits above 0, i.e. of the window the mask covers. */
export function maskShare(logits: Float32Array): number {
  let n = 0;
  for (const v of logits) if (v > 0) n++;
  return logits.length === 0 ? 0 : n / logits.length;
}

/** Highest IoU among masks at least STABLE, else the most stable; ties to the lower index. */
export function chooseMask(scores: Float32Array, stabilities: number[]): number {
  let best = -1;
  for (let i = 0; i < scores.length; i++) if (stabilities[i]! >= STABLE && (best < 0 || scores[i]! > scores[best]!)) best = i;
  if (best >= 0) return best;
  best = 0;
  for (let i = 1; i < stabilities.length; i++) if (stabilities[i]! > stabilities[best]!) best = i;
  return best;
}

/** One console line per shown decode, so a bad choice can be read off without a debugger. */
export function decodeLog(points: number, scores: Float32Array, stabilities: number[], shares: number[], chosen: number): string {
  const masks = [...scores].map((s, i) =>
    `#${i} iou ${s.toFixed(2)} stab ${stabilities[i]!.toFixed(2)} area ${Math.round(shares[i]! * 100)}%${i === chosen ? " *" : ""}`);
  return [`smart: ${points} pts`, ...masks].join(" | ");
}

/** Source index pairs and weights for bilinear upsampling with half-pixel centres, edges clamped. */
function axis(n: number, side: number): { a: Int32Array; b: Int32Array; f: Float64Array } {
  const a = new Int32Array(n), b = new Int32Array(n), f = new Float64Array(n), s = side / SAM_SIDE;
  for (let i = 0; i < n; i++) {
    const u = Math.max(0, (i + 0.5) * s - 0.5), i0 = Math.min(Math.floor(u), side - 1);
    a[i] = i0; b[i] = Math.min(i0 + 1, side - 1); f[i] = u - i0;
  }
  return { a, b, f };
}

/** w's pixels as 0 or 1: side² logits covering SAM_SIDE², upsampled bilinearly, above 0. */
export function maskBits(logits: Float32Array, side: number, w: Window): Uint8Array {
  const out = new Uint8Array(w.width * w.height), xs = axis(w.width, side), ys = axis(w.height, side);
  for (let y = 0; y < w.height; y++) {
    const r0 = ys.a[y]! * side, r1 = ys.b[y]! * side, fy = ys.f[y]!;
    for (let x = 0; x < w.width; x++) {
      const x0 = xs.a[x]!, x1 = xs.b[x]!, fx = xs.f[x]!;
      const top = (1 - fx) * logits[r0 + x0]! + fx * logits[r0 + x1]!, bottom = (1 - fx) * logits[r1 + x0]! + fx * logits[r1 + x1]!;
      out[y * w.width + x] = (1 - fy) * top + fy * bottom > 0 ? 1 : 0;
    }
  }
  return out;
}

/** The 1-bits of a window's mask as row runs in raster coordinates, sorted by row then x0. */
export function maskSpans(bits: Uint8Array, w: Window): Span[] {
  const out: Span[] = [];
  for (let y = 0; y < w.height; y++) {
    const row = y * w.width;
    for (let x = 0; x < w.width; x++) {
      if (!bits[row + x]) continue;
      const x0 = x;
      while (x < w.width && bits[row + x]) x++;
      out.push({ row: w.y0 + y, x0: w.x0 + x0, x1: w.x0 + x });
    }
  }
  return out;
}
