import { QUAD_ERR, tileQuads, type Quad } from "../core/labelQuads";
import { tileWindow } from "../core/labelStore";
import type { Grid } from "../core/types";

type Deadline = { timeRemaining(): number };
/** Runs a callback when the page is idle: requestIdleCallback, else a timeout. */
export type IdleScheduler = (cb: (deadline: Deadline) => void) => void;

const defaultIdle: IdleScheduler = (cb) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(cb);
  else setTimeout(() => cb({ timeRemaining: () => 8 }), 0);
};

/** Label tiles' quads (ADR 0019), kept for the raster's life and computed ahead in idle callbacks (spec 023 F5). */
// Corners only, under 1 KiB per tile; a new tile's overlay then takes its quads without projecting.
export class QuadCache {
  private readonly quads = new Map<string, Quad[]>();
  private queue: string[] = [];
  private scheduled = false;

  constructor(private readonly grid: Grid, private readonly idle: IdleScheduler = defaultIdle) {}

  /** The tile's quads, computed now if no idle callback did. */
  get(key: string): Quad[] {
    let q = this.quads.get(key);
    if (!q) {
      const [x0, y0] = key.split(",").map(Number) as [number, number];
      this.quads.set(key, (q = tileQuads(this.grid, tileWindow(this.grid, x0, y0), QUAD_ERR)));
    }
    return q;
  }

  /** Computes these tiles' quads in idle time, at least one per callback; replaces any earlier list. */
  prefetch(keys: string[]): void {
    this.queue = keys.filter((k) => !this.quads.has(k));
    if (!this.queue.length || this.scheduled) return;
    this.scheduled = true;
    this.idle(this.work);
  }

  private readonly work = (deadline: Deadline): void => {
    this.scheduled = false;
    do {
      const key = this.queue.shift();
      if (key === undefined) return;
      this.get(key);
    } while (deadline.timeRemaining() > 0);
    if (this.queue.length) { this.scheduled = true; this.idle(this.work); }
  };
}
