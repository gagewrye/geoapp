import type { Window } from "../core/grid";
import { brush, keepMasks, tileKeys, tileWindow, type LabelStore, type NodataMasks } from "../core/labelStore";
import { nodataMask } from "../core/nodata";
import type { RasterSource } from "./source";

/** One stroke cell: its footprint, label value, and paint or erase. */
export type PaintOp = { w: Window; value: number; erase: boolean };

type Events = {
  /** A cell was applied to the store (it may have changed nothing). */
  applied: (w: Window) => void;
  /** brush returned "full": that cell changed nothing. */
  full: () => void;
  /** The queue became non-empty (true) or empty (false). */
  busy: (busy: boolean) => void;
  /** A mask read failed; the queue has been dropped. */
  error: (e: unknown) => void;
};

/** Applies stroke cells in order, first reading missing nodata masks one tile window at a time (spec 003). */
// Cells wait while masks load, so they still apply after the stroke ends. Erase reads nothing, and
// after each cell only the masks of stored tiles and of that footprint are kept.
export class PaintQueue {
  readonly masks: NodataMasks = new Map();
  private ops: PaintOp[] = [];
  private running = false;
  private generation = 0; // bumped by clear(), so a read finishing afterwards is ignored
  private busy = false; // what on.busy last reported: a cell that throws has already left ops

  constructor(private readonly source: RasterSource, private readonly store: () => LabelStore, private readonly on: Events) {}

  /** Cells waiting or being applied. */
  get size(): number { return this.ops.length; }

  push(op: PaintOp): void {
    this.ops.push(op);
    this.setBusy(true);
    void this.run();
  }

  /** Drop every queued cell and every mask (a new raster, or a discard). */
  clear(): void {
    this.generation++;
    this.running = false;
    this.ops = [];
    this.masks.clear();
    this.setBusy(false);
  }

  /** Resolves once the queue is empty. */
  async idle(): Promise<void> {
    while (this.ops.length) await new Promise((r) => setTimeout(r, 5));
  }

  private setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.on.busy(busy);
  }

  // Runs synchronously while no read is needed, so cells with their masks in apply at once.
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    try {
      while (this.ops.length) {
        const op = this.ops[0]!;
        const store = this.store();
        if (!op.erase) {
          for (const key of tileKeys(op.w)) {
            if (this.masks.has(key)) continue;
            const [x0, y0] = key.split(",").map(Number) as [number, number];
            const t = tileWindow(store, x0, y0);
            const mask = nodataMask(await this.source.readWindow(t.x0, t.y0, t.width, t.height));
            if (gen !== this.generation) return;
            this.masks.set(key, mask);
          }
        }
        this.ops.shift();
        if (brush(store, this.masks, op.w, op.value, op.erase) === "full") this.on.full();
        keepMasks(store, this.masks, op.w);
        this.on.applied(op.w);
        if (!this.ops.length) this.setBusy(false);
      }
    } catch (e) {
      if (gen !== this.generation) return;
      this.clear();
      this.on.error(e);
    } finally {
      if (gen === this.generation) this.running = false;
    }
  }
}
