import { displaySamples } from "../core/alpha";
import { decimateInto } from "../core/decimate";
import type { Window } from "../core/grid";
import { MAX_READ_BYTES, rowReads, TASK_READ_BYTES, toRgba, type Block, type Level } from "../core/imagery";
import type { Tile } from "../core/types";
import type { ImagerySource } from "./source";
import { yieldToBrowser } from "./yieldTask";

/** Where drawn tiles go: `use` says whether a tile is already drawn, marking it recently used. */
export type TileSink = {
  use(key: string): boolean;
  draw(key: string, level: Level, tile: Window, rgba: Uint8ClampedArray<ArrayBuffer>): void;
};

/** A tile's key: its level's step and its corner in the level grid. */
export const tileKey = (level: Level, t: Window) => `${level.s}-${t.x0},${t.y0}`;

/** Spec 028: draws in one task stop once this many ms have passed in it, and the rest wait for the next task. */
export const DRAW_BUDGET_MS = 8;

/** A tile being filled: reads split at block edges (spec 020 A1), so it may need several; queued to draw when none are left. */
type Pending = { key: string; level: Level; tile: Window; bands: Float32Array[] | null; left: number; broken: boolean };
type Job = { level: Level; read: Window; tiles: Pending[]; ac: AbortController };
/** The clock and the yield the draw queue uses; tests pass fakes. */
type Deps = { now?: () => number; yieldTask?: () => Promise<void> };

// Spec 020 allows two reads in flight; an aborted read counts until it settles.
const IN_FLIGHT = 2;

const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === "AbortError";

/** Reads the imagery tiles of each view, centre first, and hands them to a sink as RGBA (spec 020 Loading, spec 028 draws). */
export class ImageryLoader {
  private queue: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly pending = new Map<string, Pending>();
  /** Filled tiles waiting to be drawn; they stay in `pending` until drawn, so a view that still wants one doesn't read it again. */
  private ready: Pending[] = [];
  /** The view's tiles, centre first: the draw order. */
  private order = new Map<string, number>();
  private draining = false;
  private readonly now: () => number;
  private readonly yieldTask: () => Promise<void>;

  /** onError: a read failed with something other than an abort (spec 020 A1 Read failures). */
  constructor(private readonly source: ImagerySource, private readonly ranges: [number, number][], private readonly sink: TileSink,
    private readonly onError: (e: unknown) => void = () => {}, deps: Deps = {}) {
    this.now = deps.now ?? (() => performance.now());
    this.yieldTask = deps.yieldTask ?? yieldToBrowser;
  }

  /** The view's plan (tiles centre first), or null for none: reads no tile of it needs stop, and the queue follows the plan. */
  show(plan: { level: Level; tiles: Window[] } | null): void {
    const missing = plan ? plan.tiles.filter((t) => !this.sink.use(tileKey(plan.level, t))) : [];
    const order = new Map(plan ? missing.map((t, i) => [tileKey(plan.level, t), i]) : []);
    this.order = order;
    const wanted = (j: Job) => j.tiles.some((p) => order.has(p.key) && !p.broken);
    for (const j of this.running) if (!j.ac.signal.aborted && !wanted(j)) { j.ac.abort(); this.drop(j); }
    const kept = this.queue.filter(wanted);
    for (const j of this.queue) if (!wanted(j)) this.drop(j);
    // a filled tile the view no longer shows is stale: it isn't drawn (spec 028)
    this.discard(this.ready.filter((p) => !order.has(p.key)));
    // tiles already in progress keep their reads; the rest get new ones
    const fresh = plan ? missing.filter((t) => !this.pending.get(tileKey(plan.level, t))) : [];
    const first = (j: Job) => Math.min(...j.tiles.map((p) => order.get(p.key) ?? Infinity));
    this.queue = [...kept, ...(plan ? this.jobs(plan.level, fresh) : [])].sort((a, b) => first(a) - first(b));
    this.pump();
  }

  /** A read is queued or in flight, or a tile waits to be drawn (spec 023: background mask reads wait for all of these). */
  busy(): boolean { return this.queue.length > 0 || this.running.size > 0 || this.ready.length > 0; }

  /** Abort every read and drop every undrawn tile (the raster closed). */
  stop(): void {
    for (const j of this.running) j.ac.abort();
    this.queue = [];
    this.discard(this.ready);
    this.pending.clear();
  }

  /** The reads for these tiles, each listing the tiles it fills. */
  private jobs(level: Level, tiles: Window[]): Job[] {
    const step = level.overview === null ? level.s : 1;
    const { width, height, block } = this.image(level);
    // geotiff decodes a whole read in one task, so its reads are smaller (spec 028); raw reads copy only what they need
    const cap = this.source.raw?.includes(level.overview ?? 0) ? MAX_READ_BYTES : TASK_READ_BYTES;
    const reads = rowReads(tiles, step, block, width, height, cap);
    const entries = tiles.map((tile): Pending => ({ key: tileKey(level, tile), level, tile, bands: null, left: 0, broken: false }));
    for (const p of entries) this.pending.set(p.key, p);
    return reads.map((read) => {
      const touched = entries.filter(({ tile: t }) => overlaps(read, { x0: t.x0 * step, y0: t.y0 * step, width: t.width * step, height: t.height * step }));
      for (const p of touched) p.left++;
      return { level, read, tiles: touched, ac: new AbortController() };
    });
  }

  /** The image a level reads, with its block: its overview's, or the full image's. */
  private image(level: Level): { width: number; height: number; block: Block } {
    if (level.overview === null) return { ...this.source.meta, block: this.source.block };
    const o = this.source.overviews.find((v) => v.index === level.overview);
    return { width: level.grid.width, height: level.grid.height, block: o?.block ?? this.source.block };
  }

  private bands(): number[] {
    return displaySamples(this.source.meta.bandCount, this.source.meta.alpha);
  }

  /** A job that won't complete: its tiles can't be drawn, so a later view asks for them again. */
  private drop(job: Job): void {
    for (const p of job.tiles) this.forget(p);
  }

  /** Filled tiles that won't be drawn: a later view asks for them again. */
  private discard(tiles: Pending[]): void {
    const gone = new Set(tiles);
    for (const p of gone) this.forget(p);
    this.ready = this.ready.filter((p) => !gone.has(p));
  }

  private forget(p: Pending): void {
    p.broken = true;
    if (this.pending.get(p.key) === p) this.pending.delete(p.key);
  }

  private pump(): void {
    while (this.running.size < IN_FLIGHT && this.queue.length) {
      const job = this.queue.shift()!;
      this.running.add(job);
      void this.run(job).finally(() => { this.running.delete(job); this.pump(); });
    }
  }

  private async run(job: Job): Promise<void> {
    const { level, read, ac } = job;
    let bands: ArrayLike<number>[];
    try {
      bands = await this.source.readSamples(level.overview ?? 0, read.x0, read.y0, read.width, read.height, this.bands(), ac.signal);
    } catch (e) {
      this.drop(job);
      if (!ac.signal.aborted && !isAbort(e)) this.onError(e);
      return; // the preview stays drawn underneath
    }
    if (ac.signal.aborted) return;
    const start = this.now();
    const step = level.overview === null ? level.s : 1;
    const { width, height } = this.image(level);
    const win = { ...read, bands };
    try {
      for (const p of job.tiles) {
        if (p.broken) continue;
        p.bands ??= bands.map(() => new Float32Array(p.tile.width * p.tile.height));
        const out: Tile = { ...p.tile, nodata: null, bands: p.bands };
        decimateInto(out, win, step, width, height);
        if (--p.left === 0) this.ready.push(p);
      }
    } catch (e) {
      this.drop(job);
      this.onError(e);
    }
    void this.drain(start);
  }

  /** Draws ready tiles, centre first, yielding to the browser once DRAW_BUDGET_MS have passed since `start` in this task (spec 028). */
  private async drain(start: number): Promise<void> {
    if (this.draining) return; // the drain already running picks the new tiles up
    this.draining = true;
    try {
      while (this.ready.length) {
        if (this.now() - start >= DRAW_BUDGET_MS) {
          await this.yieldTask();
          start = this.now();
          continue;
        }
        this.draw(this.next());
      }
    } finally {
      this.draining = false;
    }
  }

  /** Removes and returns the ready tile nearest the view's centre. */
  private next(): Pending {
    let best = 0;
    const rank = (p: Pending) => this.order.get(p.key) ?? Infinity;
    for (let i = 1; i < this.ready.length; i++) if (rank(this.ready[i]!) < rank(this.ready[best]!)) best = i;
    return this.ready.splice(best, 1)[0]!;
  }

  private draw(p: Pending): void {
    if (this.pending.get(p.key) === p) this.pending.delete(p.key);
    const bands = p.bands!, n = p.tile.width * p.tile.height;
    p.bands = null;
    const rgba = new Uint8ClampedArray(4 * n);
    toRgba(bands, n, this.ranges, this.source.meta.nodata, rgba, this.source.meta.alpha === null ? null : bands.length - 1);
    try {
      this.sink.draw(p.key, p.level, p.tile, rgba);
    } catch (e) {
      // e.g. addSource after a WebGL context loss: the tiles still waiting would fail too, so a later view asks for them again
      this.discard(this.ready);
      this.onError(e);
    }
  }
}

const overlaps = (a: Window, b: Window) => a.x0 < b.x0 + b.width && b.x0 < a.x0 + a.width && a.y0 < b.y0 + b.height && b.y0 < a.y0 + a.height;
