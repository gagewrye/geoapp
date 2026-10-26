import { GeoTIFF, type GeoTIFFImage } from "geotiff";
import { openGeoTiff } from "./geotiffSource";
import type { RasterMeta } from "./source";

export type Fetch = typeof globalThis.fetch;
type Slice = { offset: number; length: number };

/** Any failed COG request: a non-206 answer, a network error or a CORS failure (spec 002). */
export class AefDownloadError extends Error {
  constructor(readonly host: string, cause: unknown) {
    super(`Couldn't download embeddings from ${host}.`, { cause });
  }
}

// Real COGs use 1024x1024 band tiles of ~0.2-0.7 MB, so a 64 MiB block cache keeps a window's
// tiles while the next windows in the row reuse them.
const BLOCK = 65536;
const CACHE_BYTES = 64 * 2 ** 20;

/**
 * geotiff.js source sending only ranged GETs without credentials, accepting only 206, and caching
 * aligned blocks. geotiff.js's own BlockedSource replaces request errors with "Request failed"
 * and leaves the original rejection unhandled, which would hide why a download failed.
 */
class RangeSource {
  private readonly host: string;
  private readonly blocks = new Map<number, Promise<ArrayBuffer>>(); // insertion order = LRU
  private size: number | null = null;

  constructor(private readonly url: string, private readonly fetchFn: Fetch, private readonly blockSize: number) {
    this.host = new URL(url).host;
  }

  get fileSize(): number | null { return this.size; }

  async fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBuffer[]> {
    return Promise.all(slices.map((s) => this.slice(s, signal)));
  }

  async close(): Promise<void> {}

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
    const max = Math.max(1, Math.floor(CACHE_BYTES / this.blockSize));
    for (const id of this.blocks.keys()) {
      if (this.blocks.size <= max) break;
      this.blocks.delete(id);
    }
  }
}

export type RemoteCog = { url: string; meta: RasterMeta; image: GeoTIFFImage };

/** Open a COG over HTTP; reads only its header. */
export async function openRemoteCog(url: string, fetchFn: Fetch, blockSize = BLOCK): Promise<RemoteCog> {
  const source = new RangeSource(url, fetchFn, blockSize) as unknown as Parameters<typeof GeoTIFF.fromSource>[0];
  const tiff = await GeoTIFF.fromSource(source);
  const { meta } = await openGeoTiff(tiff);
  return { url, meta, image: await tiff.getImage(0) };
}

/** Raw Int8 bands of a file window [c0, r0, c1, r1], in file row order. */
export async function readInt8(cog: RemoteCog, win: [number, number, number, number]): Promise<Int8Array[]> {
  const bands = (await cog.image.readRasters({ window: win })) as unknown as ArrayLike<number>[];
  return Array.from(bands, (b) => (b instanceof Int8Array ? b : Int8Array.from(b)));
}
