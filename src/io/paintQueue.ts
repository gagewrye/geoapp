import type { Window } from "../core/grid";
import { brush, keepMasks, MAX_LABEL_TILES, tileKeys, tileWindow, type LabelStore, type NodataMasks } from "../core/labelStore";
import { nodataMask } from "../core/nodata";
import type { Tile } from "../core/types";
import { anyNonZero, baseTile, type MaskBase } from "./maskBase";
import type { RasterSource } from "./source";
import type { StrokeEdit, UndoHistory } from "./undoHistory";

/** One stroke cell: its footprint, label value, paint or erase, and the stroke's undo edit. */
export type PaintOp = { w: Window; value: number; erase: boolean; stroke?: StrokeEdit };

type Events = {
  /** A cell was applied to the store (it may have changed nothing). */
  applied: (w: Window) => void;
  /** The cell would pass MAX_LABEL_TILES (brush's "full", or copying base tiles): it changed nothing. */
  full: () => void;
  /** The queue became non-empty (true) or empty (false). */
  busy: (busy: boolean) => void;
  /** A mask or base read failed; the queue has been dropped. */
  error: (e: unknown) => void;
};

/** Applies stroke cells in order, first reading missing nodata masks one tile window at a time (spec 003). */
// Cells wait while masks load, so they still apply after the stroke ends. Erase reads nothing, and
// after each cell only the masks of stored tiles and of that footprint are kept. With a mask base
// (spec 014), a cell touching a key absent from the store first reads that key's base tile (paint
// and erase alike), and copies it into the store just before brushing, after the undo record.
export class PaintQueue {
  readonly masks: NodataMasks = new Map();
  private pending = new Map<string, Uint8Array>(); // base tiles read for the head cell, until it applies
  private ops: PaintOp[] = [];
  private running = false;
  private generation = 0; // bumped by clear(), so a read finishing afterwards is ignored
  private busy = false; // what on.busy last reported: a cell that throws has already left ops

  constructor(private readonly source: RasterSource, private readonly store: () => LabelStore, private readonly on: Events,
    private readonly history?: UndoHistory, private readonly base: () => MaskBase | null = () => null) {}

  /** Cells waiting or being applied. */
  get size(): number { return this.ops.length; }

  push(op: PaintOp): void {
    if (op.stroke) this.history?.queued(op.stroke);
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
    this.pending.clear();
    this.history?.dropQueued();
    this.setBusy(false);
  }

  private setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.on.busy(busy);
  }

  /** Copies the cell's pending base tiles into the store (non-zero ones only), then brushes; "full" changes nothing. */
  // The undo record already holds these keys as null, so undoing deletes the copies and the mask shows again.
  private apply(store: LabelStore, op: PaintOp): "ok" | "full" {
    const copies: [string, Uint8Array][] = [];
    for (const key of tileKeys(op.w)) {
      const t = this.pending.get(key);
      this.pending.delete(key);
      if (t && !store.tiles.has(key) && anyNonZero(t)) copies.push([key, t]);
    }
    if (store.tiles.size + copies.length > MAX_LABEL_TILES) return "full";
    for (const [key, t] of copies) store.tiles.set(key, t);
    const r = brush(store, this.masks, op.w, op.value, op.erase);
    if (r === "full") for (const [key] of copies) store.tiles.delete(key);
    return r;
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
        const base = store.base ? this.base() : null;
        for (const key of tileKeys(op.w)) {
          const needMask = !op.erase && !this.masks.has(key);
          const needBase = base !== null && !store.tiles.has(key) && !this.pending.has(key);
          if (!needMask && !needBase) continue;
          const [x0, y0] = key.split(",").map(Number) as [number, number];
          const t = tileWindow(store, x0, y0);
          let tile: Tile | null = null;
          if (needBase) {
            const b = await baseTile(this.source, base, t); // the base tile's imagery read serves the mask too
            if (gen !== this.generation) return;
            this.pending.set(key, b.labels);
            tile = b.tile;
          }
          if (needMask) {
            tile ??= await this.source.readWindow(t.x0, t.y0, t.width, t.height);
            if (gen !== this.generation) return;
            this.masks.set(key, nodataMask(tile));
          }
        }
        this.ops.shift();
        if (op.stroke) this.history?.record(op.stroke, op.w);
        const full = this.apply(store, op) === "full";
        if (op.stroke) this.history?.applied(op.stroke);
        if (full) this.on.full();
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
