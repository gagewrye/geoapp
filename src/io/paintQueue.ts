import type { Window } from "../core/grid";
import { brushSpans, tileWindow, type Erase, type LabelStore } from "../core/labelStore";
import { spanKeys, windowSpans, type Span } from "../core/spans";
import { anyNonZero, maskedBaseTile, type MaskBase } from "./maskBase";
import type { ValidMask } from "../core/validMask";
import { MaskCache, STROKE } from "./maskCache";
import type { RasterSource } from "./source";
import type { StrokeEdit, UndoHistory } from "./undoHistory";

/** One pointer move (spec 023 F6): the union of its footprints as spans, their bounding box, label value, paint or erase, and the stroke's undo edit. */
// done hears how the op ended: applied, or dropped with the queue (spec 046's commit).
export type PaintOp = { spans: Span[]; box: Window; value: number; erase: Erase; stroke?: StrokeEdit; done?: (r: "ok" | "dropped") => void };

/** A single footprint as a PaintOp. */
export const cellOp = (w: Window, value: number, erase: Erase, stroke?: StrokeEdit): PaintOp => ({ spans: windowSpans(w), box: w, value, erase, stroke });

type Events = {
  /** A move was applied to the store (it may have changed nothing); keys are the tiles its spans meet. */
  applied: (keys: string[]) => void;
  /** The queue became non-empty (true) or empty (false). */
  busy: (busy: boolean) => void;
  /** A mask or base read failed; the queue has been dropped. */
  error: (e: unknown) => void;
};

/** Applies pointer moves in order, first waiting for missing valid masks from the mask cache (specs 003, 023). */
// Moves wait while masks load, so they still apply after the stroke ends. Erase needs no mask, and masks are
// kept for the raster's life (ADR 0021). With a mask base (spec 014), a move touching a key absent from the
// store first reads that key's base tile, masked by the cached mask (paint and erase alike), and copies it
// into the store just before brushing, after the undo record.
export class PaintQueue {
  private pending = new Map<string, Uint8Array>(); // base tiles read for the head move, until it applies
  private held = new Map<string, ValidMask>(); // the head move's masks: a later band's read may evict one past MASK_BYTES
  private ops: PaintOp[] = [];
  private running = false;
  private generation = 0; // bumped by clear(), so a read finishing afterwards is ignored
  private busy = false; // what on.busy last reported: a move that throws has already left ops

  constructor(private readonly source: RasterSource, private readonly store: () => LabelStore, private readonly on: Events,
    private readonly history?: UndoHistory, private readonly base: () => MaskBase | null = () => null,
    readonly cache: MaskCache = new MaskCache(source)) {}

  /** The valid masks held (for tests). */
  get masks() { return this.cache.masks; }

  /** Moves waiting or being applied. */
  get size(): number { return this.ops.length; }

  push(op: PaintOp): void {
    if (op.stroke) this.history?.queued(op.stroke);
    this.ops.push(op);
    this.setBusy(true);
    void this.run();
  }

  /** Drop every queued move (a new raster, or a failed read); the masks stay with their cache. */
  clear(): void {
    this.generation++;
    this.running = false;
    const dropped = this.ops;
    this.ops = [];
    this.pending.clear();
    this.held.clear();
    this.history?.dropQueued();
    this.setBusy(false);
    for (const op of dropped) op.done?.("dropped");
  }

  private setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.on.busy(busy);
  }

  /** Copies the move's pending base tiles into the store (non-zero ones only), then brushes. */
  // The undo record already holds these keys as null, so undoing deletes the copies and the mask shows again.
  private apply(store: LabelStore, op: PaintOp, keys: string[]): void {
    for (const key of keys) {
      const t = this.pending.get(key);
      this.pending.delete(key);
      if (t && !store.tiles.has(key) && anyNonZero(t)) store.tiles.set(key, t);
    }
    brushSpans(store, { get: (k) => this.held.get(k) ?? this.cache.get(k) }, op.spans, op.value, op.erase);
  }

  // Runs synchronously while no read is needed, so moves with their masks in apply at once.
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    try {
      while (this.ops.length) {
        const op = this.ops[0]!;
        const store = this.store();
        const base = store.base ? this.base() : null;
        const keys = spanKeys(op.spans);
        for (const key of keys) {
          const needBase = base !== null && !store.tiles.has(key) && !this.pending.has(key);
          if (op.erase && !needBase) continue;
          const [x0, y0] = key.split(",").map(Number) as [number, number];
          let mask = this.held.get(key) ?? this.cache.get(key);
          // other moves' band reads could evict it again each time, past MASK_BYTES: fail rather than loop
          for (let tries = 0; !mask; tries++) {
            if (tries === 2) throw new Error(`The valid mask of tile ${key} was evicted before it could be used`);
            await this.cache.need(y0, STROKE);
            if (gen !== this.generation) return;
            mask = this.cache.get(key);
          }
          this.held.set(key, mask);
          if (needBase) {
            const labels = await maskedBaseTile(this.source, base, tileWindow(store, x0, y0), mask);
            if (gen !== this.generation) return;
            this.pending.set(key, labels);
          }
        }
        this.ops.shift();
        if (op.stroke) this.history?.record(op.stroke, keys);
        this.apply(store, op, keys);
        this.held.clear();
        if (op.stroke) this.history?.applied(op.stroke);
        this.on.applied(keys);
        op.done?.("ok");
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
