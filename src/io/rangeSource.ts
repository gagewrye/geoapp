export type Fetch = typeof globalThis.fetch;
type Slice = { offset: number; length: number };

/** Any failed COG request: a non-206 answer, a network error or a CORS failure (spec 002). */
export class AefDownloadError extends Error {
  constructor(readonly host: string, cause: unknown) {
    super(`Couldn't download embeddings from ${host}.`, { cause });
  }
}

// Header reads (IFDs, tag arrays) go through aligned blocks; the cap only matters for odd files.
export const BLOCK = 65536;
const HEADER_CACHE_BYTES = 16 * 2 ** 20;

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

  constructor(private readonly url: string, private readonly fetchFn: Fetch, private readonly blockSize: number) {
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

  private async get(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, { method: "GET", headers: { Range: `bytes=${start}-${end}` }, credentials: "omit", signal });
    } catch (e) {
      throw new AefDownloadError(this.host, e); // browsers report CORS failures as network errors
    }
    // a 200 would mean the host ignored Range and is sending the whole multi-GB file
    if (res.status !== 206) throw new AefDownloadError(this.host, new Error(`HTTP ${res.status} for ${this.url}`));
    const want = this.expected(start, end, res.headers.get("Content-Range"));
    let body: ArrayBuffer;
    try {
      body = await res.arrayBuffer();
    } catch (e) {
      throw new AefDownloadError(this.host, e); // connection lost mid-body
    }
    if (body.byteLength !== want) throw new AefDownloadError(this.host, new Error(`${body.byteLength} bytes for a ${want}-byte range of ${this.url}`));
    return body;
  }

  /**
   * Byte count a 206 must carry. Its Content-Range must start where asked, end where asked (or at
   * the last byte when the range runs past the file), and give the same file size every time;
   * otherwise its bytes are not the asked ones and would be decoded as the wrong pixels.
   */
  private expected(start: number, end: number, contentRange: string | null): number {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
    const [s, e, total] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN];
    if (s !== start || start >= total || e !== Math.min(end, total - 1) || (this.size !== null && total !== this.size)) {
      throw new AefDownloadError(this.host, new Error(`Content-Range ${JSON.stringify(contentRange)} for bytes=${start}-${end} of ${this.url}`));
    }
    this.size = total;
    return e - s + 1;
  }

  private evict(): void {
    const max = Math.max(1, Math.floor(HEADER_CACHE_BYTES / this.blockSize));
    for (const id of this.blocks.keys()) {
      if (this.blocks.size <= max) break;
      this.blocks.delete(id);
    }
  }
}
