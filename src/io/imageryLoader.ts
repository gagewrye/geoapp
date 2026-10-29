import { decimateInto } from "../core/decimate";
import type { Window } from "../core/grid";
import { rowReads, toRgba, type Level } from "../core/imagery";
import type { ImagerySource } from "./source";

/** Where drawn tiles go: `use` says whether a tile is already drawn, marking it recently used. */
export type TileSink = {
  use(key: string): boolean;
  draw(key: string, level: Level, tile: Window, rgba: Uint8ClampedArray<ArrayBuffer>): void;
};

/** A tile's key: its level's step and its corner in the level grid. */
export const tileKey = (level: Level, t: Window) => `${level.s}-${t.x0},${t.y0}`;

type Job = { level: Level; read: Window; tiles: Window[]; keys: string[]; ac: AbortController; first: number };

// Spec 020's memory estimate allows two reads of at most MAX_READ_BYTES in flight; an aborted read counts until it settles.
const IN_FLIGHT = 2;

/** Reads the imagery tiles of each view, centre first, and hands them to a sink as RGBA (spec 020 Loading). */
export class ImageryLoader {
  private queue: Job[] = [];
  private readonly running = new Set<Job>();

  constructor(private readonly source: ImagerySource, private readonly ranges: [number, number][], private readonly sink: TileSink) {}

  /** The view's plan (tiles centre first), or null for none: reads no longer needed stop, and queued ones are replaced. */
  show(plan: { level: Level; tiles: Window[] } | null): void {
    const missing = plan ? plan.tiles.filter((t) => !this.sink.use(tileKey(plan.level, t))) : [];
    const want = new Set(plan ? missing.map((t) => tileKey(plan.level, t)) : []);
    for (const j of this.running) if (!j.keys.some((k) => want.has(k))) j.ac.abort();
    const reading = new Set([...this.running].filter((j) => !j.ac.signal.aborted).flatMap((j) => j.keys));
    this.queue = plan ? this.jobs(plan.level, missing.filter((t) => !reading.has(tileKey(plan.level, t)))) : [];
    this.pump();
  }

  /** Abort every read (the raster closed). */
  stop(): void {
    for (const j of this.running) j.ac.abort();
    this.queue = [];
  }

  /** One job per read window, in the order of their first tile (centre first). */
  private jobs(level: Level, tiles: Window[]): Job[] {
    const step = level.overview === null ? level.s : 1;
    const { width, height } = this.image(level);
    const nb = this.bands().length;
    const order = new Map(tiles.map((t, i) => [t, i]));
    return rowReads(tiles, step, nb * this.source.block.sampleBytes).map((w) => {
      const inside = tiles.filter((t) => t.y0 * step === w.y0 && t.x0 * step >= w.x0 && (t.x0 + t.width) * step <= w.x0 + w.width);
      // the last texel's span may pass the image edge; it samples the last pixel (decimateInto clamps)
      const read = { ...w, width: Math.min(w.width, width - w.x0), height: Math.min(w.height, height - w.y0) };
      return { level, read, tiles: inside, keys: inside.map((t) => tileKey(level, t)), ac: new AbortController(), first: Math.min(...inside.map((t) => order.get(t)!)) };
    }).sort((a, b) => a.first - b.first);
  }

  /** The size of the image a level reads: its overview's, or the full image's. */
  private image(level: Level) {
    return level.overview === null ? this.source.meta : level.grid;
  }

  private bands(): number[] {
    return this.source.meta.bandCount >= 3 ? [0, 1, 2] : [0];
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
    } catch {
      return; // aborted, or unreadable: the preview stays drawn underneath (spec 020 Decided 2)
    }
    if (ac.signal.aborted) return;
    const step = level.overview === null ? level.s : 1;
    const { width, height } = this.image(level);
    const win = { ...read, bands };
    for (const t of job.tiles) {
      const n = t.width * t.height;
      const tile = { ...t, nodata: null, bands: bands.map(() => new Float32Array(n)) };
      decimateInto(tile, win, step, width, height);
      const rgba = new Uint8ClampedArray(4 * n);
      toRgba(tile.bands, n, this.ranges, this.source.meta.nodata, rgba);
      this.sink.draw(tileKey(level, t), level, t, rgba);
    }
  }
}
