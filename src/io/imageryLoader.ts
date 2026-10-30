import { displaySamples } from "../core/alpha";
import { decimateInto } from "../core/decimate";
import type { Window } from "../core/grid";
import { rowReads, toRgba, type Block, type Level } from "../core/imagery";
import type { Tile } from "../core/types";
import type { ImagerySource } from "./source";

/** Where drawn tiles go: `use` says whether a tile is already drawn, marking it recently used. */
export type TileSink = {
  use(key: string): boolean;
  draw(key: string, level: Level, tile: Window, rgba: Uint8ClampedArray<ArrayBuffer>): void;
};

/** A tile's key: its level's step and its corner in the level grid. */
export const tileKey = (level: Level, t: Window) => `${level.s}-${t.x0},${t.y0}`;

/** A tile being filled: reads split at block edges (spec 020 A1), so it may need several; drawn when none are left. */
type Pending = { key: string; level: Level; tile: Window; bands: Float32Array[] | null; left: number; broken: boolean };
type Job = { level: Level; read: Window; tiles: Pending[]; ac: AbortController };

// Spec 020 allows two reads in flight; an aborted read counts until it settles.
const IN_FLIGHT = 2;

const isAbort = (e: unknown) => (e as { name?: unknown } | null)?.name === "AbortError";

/** Reads the imagery tiles of each view, centre first, and hands them to a sink as RGBA (spec 020 Loading). */
export class ImageryLoader {
  private queue: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly pending = new Map<string, Pending>();

  /** onError: a read failed with something other than an abort (spec 020 A1 Read failures). */
  constructor(private readonly source: ImagerySource, private readonly ranges: [number, number][], private readonly sink: TileSink,
    private readonly onError: (e: unknown) => void = () => {}) {}

  /** The view's plan (tiles centre first), or null for none: reads no tile of it needs stop, and the queue follows the plan. */
  show(plan: { level: Level; tiles: Window[] } | null): void {
    const missing = plan ? plan.tiles.filter((t) => !this.sink.use(tileKey(plan.level, t))) : [];
    const order = new Map(plan ? missing.map((t, i) => [tileKey(plan.level, t), i]) : []);
    const wanted = (j: Job) => j.tiles.some((p) => order.has(p.key) && !p.broken);
    for (const j of this.running) if (!j.ac.signal.aborted && !wanted(j)) { j.ac.abort(); this.drop(j); }
    const kept = this.queue.filter(wanted);
    for (const j of this.queue) if (!wanted(j)) this.drop(j);
    // tiles already in progress keep their reads; the rest get new ones
    const fresh = plan ? missing.filter((t) => !this.pending.get(tileKey(plan.level, t))) : [];
    const first = (j: Job) => Math.min(...j.tiles.map((p) => order.get(p.key) ?? Infinity));
    this.queue = [...kept, ...(plan ? this.jobs(plan.level, fresh) : [])].sort((a, b) => first(a) - first(b));
    this.pump();
  }

  /** A read is queued or in flight (spec 023: background mask reads wait for neither). */
  busy(): boolean { return this.queue.length > 0 || this.running.size > 0; }

  /** Abort every read (the raster closed). */
  stop(): void {
    for (const j of this.running) j.ac.abort();
    this.queue = [];
    this.pending.clear();
  }

  /** The reads for these tiles, each listing the tiles it fills. */
  private jobs(level: Level, tiles: Window[]): Job[] {
    const step = level.overview === null ? level.s : 1;
    const { width, height, block } = this.image(level);
    const reads = rowReads(tiles, step, block, width, height);
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
    for (const p of job.tiles) {
      p.broken = true;
      if (this.pending.get(p.key) === p) this.pending.delete(p.key);
    }
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
    const step = level.overview === null ? level.s : 1;
    const { width, height } = this.image(level);
    const win = { ...read, bands };
    try {
      for (const p of job.tiles) {
        if (p.broken) continue;
        const n = p.tile.width * p.tile.height;
        p.bands ??= bands.map(() => new Float32Array(n));
        const out: Tile = { ...p.tile, nodata: null, bands: p.bands };
        decimateInto(out, win, step, width, height);
        if (--p.left > 0) continue;
        this.pending.delete(p.key);
        const rgba = new Uint8ClampedArray(4 * n);
        toRgba(p.bands, n, this.ranges, this.source.meta.nodata, rgba, this.source.meta.alpha === null ? null : p.bands.length - 1);
        this.sink.draw(p.key, level, p.tile, rgba);
      }
    } catch (e) {
      // e.g. addSource after a WebGL context loss: the job's undrawn tiles are asked for again on a later view
      this.drop(job);
      this.onError(e);
    }
  }
}

const overlaps = (a: Window, b: Window) => a.x0 < b.x0 + b.width && b.x0 < a.x0 + a.width && a.y0 < b.y0 + b.height && b.y0 < a.y0 + a.height;
