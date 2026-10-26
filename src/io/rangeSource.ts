import { AefDownloadError, getRange, IDLE_TIMEOUT_MS, type Fetch } from "./rangeGet";

export { AefDownloadError, type Fetch } from "./rangeGet";

type Slice = { offset: number; length: number };

// Header reads (IFDs, tag arrays) go through aligned blocks; the cap only matters for odd files.
export const BLOCK = 65536;
const HEADER_CACHE_BYTES = 16 * 2 ** 20;
// Browsers open 6 connections per host over HTTP/1.1; more would wait in the browser's queue
// without progress and trip the idle timeout. The cap is per COG (per RangeSource); it holds per
// host only because fetchEntries reads one COG at a time. Parallel COG reads need a shared limiter.
const MAX_IN_FLIGHT = 6;

/**
 * geotiff.js source sending only ranged GETs without credentials and accepting only exact 206s.
 * Header reads are cached in aligned blocks. Planned tiles are fetched exactly (reusing bytes
 * already in header blocks) and kept until released, so no tile is fetched twice. geotiff.js's
 * own BlockedSource replaces request errors with "Request failed" and leaves the original
 * rejection unhandled, which would hide why a download failed.
 */
export class RangeSource {
  private readonly host: string;
  private readonly blocks = new Map<number, Promise<ArrayBuffer>>(); // insertion order = LRU
  private readonly planned = new Map<number, number>(); // tile offset -> byte count
  private readonly tiles = new Map<number, Promise<ArrayBuffer>>(); // planned tiles read and not yet released
  private size: number | null = null;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  // a download is all or nothing, so the first failure stops every other request at once
  private failed: AefDownloadError | null = null;
  private readonly stop = new AbortController();

  constructor(private readonly url: string, private readonly fetchFn: Fetch, private readonly blockSize: number, private readonly timeoutMs = IDLE_TIMEOUT_MS) {
    this.host = new URL(url).host;
  }

  get fileSize(): number | null { return this.size; }

  async fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBuffer[]> {
    return Promise.all(slices.map((s) => (this.planned.get(s.offset) === s.length ? this.tile(s, signal) : this.slice(s, signal))));
  }

  async close(): Promise<void> {}

  /** Read this tile exactly and keep it until release(offset). */
  plan(offset: number, length: number): void { this.planned.set(offset, length); }

  release(offset: number): void { this.tiles.delete(offset); }

  private tile({ offset, length }: Slice, signal?: AbortSignal): Promise<ArrayBuffer> {
    let t = this.tiles.get(offset);
    if (!t) {
      const p = this.exact(offset, length, signal);
      this.tiles.set(offset, p);
      p.catch(() => { if (this.tiles.get(offset) === p) this.tiles.delete(offset); });
      t = p;
    }
    return t;
  }

  /** Bytes [offset, offset + length): parts in cached header blocks are copied, the gaps fetched exactly. */
  private async exact(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const bs = this.blockSize, end = offset + length;
    const out = new Uint8Array(length);
    const parts: Promise<void>[] = [];
    const first = Math.floor(offset / bs), last = Math.floor((end - 1) / bs);
    let gap: number | null = null;
    for (let id = first; id <= last + 1; id++) {
      const at = Math.min(end, Math.max(offset, id * bs)); // where block id's share of the tile starts
      const cached = id <= last ? this.blocks.get(id) : undefined;
      if (id <= last && !cached) { gap ??= at; continue; }
      if (gap !== null) {
        const a = gap;
        parts.push(this.get(a, at - 1, signal).then((buf) => {
          if (buf.byteLength !== at - a) throw new AefDownloadError(this.host, new Error(`${this.url} ends inside a tile`));
          out.set(new Uint8Array(buf), a - offset);
        }));
        gap = null;
      }
      if (cached) {
        const to = Math.min(end, (id + 1) * bs);
        parts.push(cached.then((buf) => {
          if (buf.byteLength < to - id * bs) throw new AefDownloadError(this.host, new Error(`${this.url} ends inside a tile`));
          out.set(new Uint8Array(buf, at - id * bs, to - at), at - offset);
        }));
      }
    }
    await Promise.all(parts);
    return out.buffer;
  }

  private async slice({ offset, length }: Slice, signal?: AbortSignal): Promise<ArrayBuffer> {
    const first = Math.floor(offset / this.blockSize), last = Math.floor((offset + length - 1) / this.blockSize);
    let run: number | null = null;
    for (let id = first; id <= last + 1; id++) {
      const cached = id <= last && this.blocks.get(id);
      if (cached) { this.blocks.delete(id); this.blocks.set(id, cached); } // mark recently used
      if (id <= last && !cached) { run ??= id; continue; }
      if (run !== null) this.request(run, id - 1, signal);
      run = null;
    }
    const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this.blocks.get(first + i)!));
    this.evict();
    const out = new Uint8Array(length);
    parts.forEach((p, i) => {
      const start = (first + i) * this.blockSize;
      const from = Math.max(offset, start) - start, to = Math.min(offset + length, start + p.byteLength) - start;
      if (to > from) out.set(new Uint8Array(p, from, to - from), start + from - offset);
    });
    return out.buffer;
  }

  /** One GET for blocks a..b; each block's promise resolves to its bytes. */
  private request(a: number, b: number, signal?: AbortSignal): void {
    const all = this.get(a * this.blockSize, (b + 1) * this.blockSize - 1, signal);
    for (let id = a; id <= b; id++) {
      const at = (id - a) * this.blockSize;
      const block = all.then((buf) => buf.slice(at, at + this.blockSize));
      this.blocks.set(id, block);
      block.catch(() => { if (this.blocks.get(id) === block) this.blocks.delete(id); }); // refetched if asked for again
    }
  }

  /** A validated ranged GET, waiting for one of MAX_IN_FLIGHT slots first. */
  private async get(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (this.active < MAX_IN_FLIGHT) this.active++;
    else await new Promise<void>((go) => this.waiting.push(go)); // the finishing request hands over its slot
    try {
      if (this.failed) throw this.failed;
      const stop = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal;
      const { body, total } = await getRange({ url: this.url, fetchFn: this.fetchFn, start, end, size: this.size, timeoutMs: this.timeoutMs, signal: stop });
      this.size = total;
      return body;
    } catch (e) {
      if (!this.failed && e instanceof AefDownloadError) { this.failed = e; this.stop.abort(e); }
      throw e;
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }

  private evict(): void {
    const max = Math.max(1, Math.floor(HEADER_CACHE_BYTES / this.blockSize));
    for (const id of this.blocks.keys()) {
      if (this.blocks.size <= max) break;
      this.blocks.delete(id);
    }
  }
}
