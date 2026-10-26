import { AEF_BANDS, AEF_BASE, AEF_NODATA_Q, type AefEntry, type Aoi } from "../core/aef";
import { selectEntries } from "../core/aoi";
import { tileWindows } from "../core/grid";
import { overlapWindow, pasteBand, placeCog, tileLastWindow, type Placement } from "../core/mosaic";
import { TILE_SIZE } from "../core/types";
import { cacheSource, PLANE_BYTES, type BandWriter, type CacheStore } from "./aefCache";
import { loadShard } from "./aefIndex";
import { AefDownloadError, openRemoteCog, planTiles, readInt8, release, type Fetch, type RemoteCog } from "./aefRemote";
import type { RasterSource } from "./source";

export class NoEmbeddingsError extends Error {
  constructor(readonly year: number) {
    super(`No AlphaEarth embeddings here for ${year}.`);
  }
}

export class AefGridError extends Error {
  constructor(readonly path: string) {
    super(`AlphaEarth file ${path} is not on the area's 10 m grid.`);
  }
}

/** blockSize and timeoutMs (per COG request, without progress) are for tests. */
type Options = { fetch?: Fetch; base?: string; appBase?: string; blockSize?: number; timeoutMs?: number };

/** Look up the AOI's COGs for the year and stream them into the cache (spec 002). */
export async function downloadAoi(aoi: Aoi, year: number, store: CacheStore, opts: Options = {}): Promise<RasterSource> {
  const fetchFn = opts.fetch ?? fetch;
  const index = opts.appBase === undefined ? await loadShard(year, aoi.epsg, fetchFn) : await loadShard(year, aoi.epsg, fetchFn, opts.appBase);
  const entries = selectEntries(index, aoi, year);
  if (entries.length === 0) throw new NoEmbeddingsError(year); // before any COG request
  return fetchEntries(aoi, entries, store, opts);
}

/** Bands per download pass (spec 002 Cache): peak memory scales with this, not with all 64. */
export const BAND_GROUP = 8;

/**
 * Open every COG, refuse any off the AOI grid, then fill the cache in band-group passes, window by
 * window in row-major order within each. The requests depend only on the AOI and the entries. On
 * failure the cache is discarded. Where COGs overlap, a valid value beats no data, and among valid
 * values the COG whose path sorts first wins, so the result does not depend on index order.
 * Each compressed tile is fetched once and kept until its last window in its pass: for tiles at
 * least 256 px on a side, per COG at most group x (tile columns across the AOI + 2) tiles, plus
 * group x 4 decoded tiles while one window is read. Real AEF COGs are band-separate (1024 px
 * tiles), so that is 8 x 5 compressed and 32 decoded 1 MiB tiles at the 2048 px cap.
 */
export async function fetchEntries(aoi: Aoi, entries: AefEntry[], store: CacheStore, opts: Options = {}): Promise<RasterSource> {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.base ?? AEF_BASE;
  const open = new Set<BandWriter>();
  try {
    const cogs: { cog: RemoteCog; at: Placement }[] = [];
    const byPath = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const e of byPath) {
      const cog = await openRemoteCog(base + e.path, fetchFn, { blockSize: opts.blockSize, timeoutMs: opts.timeoutMs });
      const { gt, width, height, bandCount, epsg } = cog.meta;
      const at = placeCog(aoi, gt, width, height);
      if (!at || epsg !== aoi.epsg) throw new AefGridError(e.path);
      if (bandCount !== AEF_BANDS) throw new Error(`AlphaEarth file ${e.path} has ${bandCount} bands, not ${AEF_BANDS}.`);
      cogs.push({ cog, at });
    }
    const windows = tileWindows(aoi.width, aoi.height);
    // a pixel-interleaved tile holds all 64 bands; splitting its bands into passes would refetch it
    const group = cogs.every(({ cog }) => cog.layout.bandSeparate) ? BAND_GROUP : AEF_BANDS;
    for (const { cog, at } of cogs) planTiles(cog, tileLastWindow(at, cog.layout.tileWidth, cog.layout.tileHeight, aoi.width, aoi.height), windows.length, group);
    for (let b0 = 0; b0 < AEF_BANDS; b0 += group) {
      const bands: [number, number] = [b0, Math.min(b0 + group, AEF_BANDS)];
      const writers: BandWriter[] = [];
      for (let b = bands[0]; b < bands[1]; b++) {
        const w = await store.band(b);
        writers.push(w); open.add(w);
      }
      const buf = new Int8Array(writers.length * PLANE_BYTES);
      const plane = (k: number) => buf.subarray(k * PLANE_BYTES, (k + 1) * PLANE_BYTES);
      for (const [i, win] of windows.entries()) {
        buf.fill(AEF_NODATA_Q); // pixels no COG covers stay no data
        for (const { cog, at } of cogs) {
          const o = overlapWindow(at, win);
          if (!o) continue;
          (await readInt8(cog, o.src, bands)).forEach((b, k) => pasteBand(plane(k), TILE_SIZE, b, o));
        }
        await Promise.all(writers.map((w, k) => w.append(plane(k))));
        for (const { cog } of cogs) release(cog, (b0 / group) * windows.length + i);
      }
      for (const w of writers) { await w.close(); open.delete(w); }
    }
    return cacheSource(aoi, store);
  } catch (e) {
    for (const w of open) await w.abort().catch(() => {}); // an open file could block deleting the cache
    await store.discard().catch(() => {}); // a failed cleanup must not hide the cause
    throw downloadCause(e);
  }
}

/** geotiff.js may wrap the client's error; surface the download failure itself. */
function downloadCause(e: unknown): unknown {
  for (let c: unknown = e; c instanceof Error; c = c.cause) if (c instanceof AefDownloadError) return c;
  if (e instanceof AggregateError) for (const c of e.errors) if (c instanceof AefDownloadError) return c;
  return e;
}
