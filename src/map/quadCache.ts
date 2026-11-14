import { QUAD_ERR, tileQuads, type Quad } from "../core/labelQuads";
import { tileWindow } from "../core/labelStore";
import type { Grid } from "../core/types";

type Deadline = { timeRemaining(): number; didTimeout?: boolean };
/** Runs a callback when the page is idle: requestIdleCallback, else a timeout. */
export type IdleScheduler = (cb: (deadline: Deadline) => void) => void;

/** One tileQuads takes 30-130 ms on UTM: a tile starts only in a near-full idle period (they last up to 50 ms). */
const MIN_IDLE_MS = 40;

// The timeout lets the work finish while the user hovers on a busy page; without requestIdleCallback, one tile per timeout.
const defaultIdle: IdleScheduler = (cb) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(cb, { timeout: 1000 });
  else setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 50);
};

/** Label tiles' quads (ADR 0019), kept for the raster's life and computed ahead in idle callbacks (spec 023 F5). */
// Corners only, under 1 KiB per tile; a new tile's overlay then takes its quads without projecting.
export class QuadCache {
  private readonly quads = new Map<string, Quad[]>();
  private queue: string[] = [];
  private scheduled = false;

  constructor(private readonly grid: Grid, private readonly idle: IdleScheduler = defaultIdle) {}

  /** Prefetched tiles are still queued. */
  get busy(): boolean { return this.queue.length > 0; }

  /** The tile's quads, computed now if no idle callback did. */
  get(key: string): Quad[] {
    let q = this.quads.get(key);
    if (!q) {
      const [x0, y0] = key.split(",").map(Number) as [number, number];
      this.quads.set(key, (q = tileQuads(this.grid, tileWindow(this.grid, x0, y0), QUAD_ERR)));
    }
    return q;
  }

  /** Computes these tiles' quads in idle time; replaces any earlier list. */
  prefetch(keys: string[]): void {
    this.queue = keys.filter((k) => !this.quads.has(k));
    if (!this.queue.length || this.scheduled) return;
    this.scheduled = true;
    this.idle(this.work);
  }

  private readonly work = (deadline: Deadline): void => {
    this.scheduled = false;
    // a timed-out callback computes one tile, so a long busy spell still ends the work
    let timedOut = deadline.didTimeout === true;
    while (this.queue.length && (timedOut || deadline.timeRemaining() >= MIN_IDLE_MS)) {
      timedOut = false;
      this.get(this.queue.shift()!);
    }
    if (this.queue.length) { this.scheduled = true; this.idle(this.work); }
  };
}
