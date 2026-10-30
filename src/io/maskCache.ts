import { maskSamples } from "../core/alpha";
import type { Window } from "../core/grid";
import { rowReads } from "../core/imagery";
import { markNodata } from "../core/nodata";
import { nodataPossible } from "../core/seed";
import { TILE_SIZE } from "../core/types";
import { bandOrder, compactMask, MaskStore, type ValidMask } from "../core/validMask";
import type { RasterSource } from "./source";

/** Priorities of need(): a queued stroke cell waits on the band, or the Paint hover is near it (spec 023 F3). */
export const STROKE = 0, HOVER = 1;

type Deps = {
  /** Spec 020's loader has a read queued or in flight: background reads wait. */
  loaderBusy?: () => boolean;
  /** An import runs: background reads wait. */
  paused?: () => boolean;
  /** How long a waiting background read sleeps before it looks again. */
  retryMs?: number;
};
type Request = { priority: number; waiters: { resolve: () => void; reject: (e: unknown) => void }[] };

type Read = Window & { bands: ArrayLike<number>[] };

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Valid masks of a raster's 256x256 windows, read one 256-row band at a time and kept for its life (spec 023 F1-F3, ADR 0021). */
// One read at a time: stroke bands, then hover bands, then the background from the view's centre band outwards,
// the background only after start() and while the loader is idle and no import runs. stop() ends everything.
export class MaskCache {
  readonly masks = new MaskStore();
  private readonly requests = new Map<number, Request>();
  private readonly read = new Set<number>(); // bands read once (the background skips them)
  private order: number[] = [];
  private started = false;
  private stopped = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly source: RasterSource, private readonly deps: Deps = {}) {}

  /** 256-row bands of the raster. */
  get bands(): number { return Math.ceil(this.source.meta.height / TILE_SIZE); }
  /** Every band has been read once. */
  get finished(): boolean { return this.read.size >= this.bands; }

  get(key: string): ValidMask | undefined { return this.masks.get(key); }

  /** Resolves once every window of the band holding row y0 has a mask; rejects if its read fails or the cache stops. */
  need(y0: number, priority: number): Promise<void> {
    const band = Math.floor(y0 / TILE_SIZE);
    if (this.stopped) return Promise.reject(new DOMException("Mask reads stopped", "AbortError"));
    if (band < 0 || band >= this.bands || this.complete(band)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const r = this.requests.get(band);
      if (r) { r.priority = Math.min(r.priority, priority); r.waiters.push({ resolve, reject }); }
      else this.requests.set(band, { priority, waiters: [{ resolve, reject }] });
      void this.pump();
    });
  }

  /** Starts the background reads, from the band holding row centreRow outwards. */
  start(centreRow: number): void {
    if (this.stopped) return;
    this.started = true;
    this.order = bandOrder(this.bands, Math.floor(centreRow / TILE_SIZE));
    void this.pump();
  }

  /** Stops every read (another raster opened): waiting needs reject, and a read in flight is discarded. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const e = new DOMException("Mask reads stopped", "AbortError");
    for (const r of this.requests.values()) for (const w of r.waiters) w.reject(e);
    this.requests.clear();
  }

  private complete(band: number): boolean {
    for (const w of this.windows(band)) if (!this.masks.has(`${w.x0},${w.y0}`)) return false;
    return true;
  }

  private windows(band: number): Window[] {
    const { width, height } = this.source.meta, y0 = band * TILE_SIZE, h = Math.min(TILE_SIZE, height - y0);
    const out: Window[] = [];
    for (let x0 = 0; x0 < width; x0 += TILE_SIZE) out.push({ x0, y0, width: Math.min(TILE_SIZE, width - x0), height: h });
    return out;
  }

  /** The next band to read: the most urgent request, else the background's next unread band; "wait" while the background must. */
  private next(): { band: number; request: boolean } | "wait" | null {
    let best: number | null = null;
    for (const [band, r] of this.requests) if (best === null || r.priority < this.requests.get(best)!.priority) best = band;
    if (best !== null) return { band: best, request: true };
    if (!this.started) return null;
    const band = this.order.find((b) => !this.read.has(b));
    if (band === undefined) return null;
    return this.deps.loaderBusy?.() || this.deps.paused?.() ? "wait" : { band, request: false };
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (;;) {
        const n = this.next();
        if (n === null || this.stopped) return;
        if (n === "wait") {
          if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, this.deps.retryMs ?? 50);
          return;
        }
        let error: unknown = null;
        try { await this.readBand(n.band); } catch (e) { error = e; }
        if (this.stopped) return;
        this.read.add(n.band);
        const r = this.requests.get(n.band);
        this.requests.delete(n.band);
        for (const w of r?.waiters ?? []) if (error) w.reject(error); else w.resolve();
        // a background error is left for a stroke's own need() to report
        if (!n.request || error) await macrotask(); // yield between background reads
      }
    } finally {
      this.running = false;
    }
  }

  /** Reads one band through spec 020's rowReads (spec 023 F2) and stores every window's mask. */
  // Peak memory is one read at the file's sample type plus 1 bit per pixel of the band (ADR 0021's 48 MiB): each
  // read's nodata pixels are marked straight into the windows' bits.
  private async readBand(band: number): Promise<void> {
    const { meta } = this.source;
    const { width, height, bandCount, nodata, float, alpha } = meta;
    const windows = this.windows(band);
    if (!nodataPossible(nodata, float, alpha !== null)) {
      for (const w of windows) this.masks.set(`${w.x0},${w.y0}`, "all");
      return;
    }
    const m = maskSamples(bandCount, nodata, float, alpha);
    const bits = windows.map((w) => new Uint8Array(Math.ceil((w.width * w.height) / 8)));
    const all = { x0: 0, y0: windows[0]!.y0, width, height: windows[0]!.height };
    const { block, readSamples } = this.source;
    const reads: (() => Promise<Read>)[] = block && readSamples
      ? rowReads([all], 1, block, width, height).map((r) => async () => ({ ...r, bands: await readSamples.call(this.source, 0, r.x0, r.y0, r.width, r.height, m.samples) }))
      // readWindow decodes every band as Float32: bound its reads as if each 256 px row segment were a block
      : rowReads([all], 1, { width: TILE_SIZE, height: 1, bytes: TILE_SIZE * bandCount * 4 }, width, height).map((r) => async () => {
        const t = await this.source.readWindow(r.x0, r.y0, r.width, r.height);
        return { ...r, bands: m.samples.map((k) => t.bands[k]!) };
      });
    for (const read of reads) {
      const r = await read();
      if (this.stopped) return;
      windows.forEach((w, i) => markNodata(bits[i]!, w, r, nodata, m.alpha));
    }
    windows.forEach((w, i) => this.masks.set(`${w.x0},${w.y0}`, compactMask(bits[i]!, w.width * w.height)));
  }
}
