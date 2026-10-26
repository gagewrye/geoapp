import { AEF_BANDS, AEF_BASE, AEF_NODATA_Q, type AefEntry, type Aoi } from "../core/aef";
import { selectEntries } from "../core/aoi";
import { tileWindows } from "../core/grid";
import { overlapWindow, pasteBand, placeCog, type Placement } from "../core/mosaic";
import { TILE_SIZE } from "../core/types";
import { cacheSource, WINDOW_BYTES, type CacheStore } from "./aefCache";
import { loadShard } from "./aefIndex";
import { AefDownloadError, openRemoteCog, readInt8, type Fetch, type RemoteCog } from "./aefRemote";
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

type Options = { fetch?: Fetch; base?: string; appBase?: string; blockSize?: number };

/** Look up the AOI's COGs for the year and stream them into the cache (spec 002). */
export async function downloadAoi(aoi: Aoi, year: number, store: CacheStore, opts: Options = {}): Promise<RasterSource> {
  const fetchFn = opts.fetch ?? fetch;
  const index = opts.appBase === undefined ? await loadShard(year, aoi.epsg, fetchFn) : await loadShard(year, aoi.epsg, fetchFn, opts.appBase);
  const entries = selectEntries(index, aoi, year);
  if (entries.length === 0) throw new NoEmbeddingsError(year); // before any COG request
  return fetchEntries(aoi, entries, store, opts);
}

/**
 * Open every COG, refuse any off the AOI grid, then fill the cache window by window in row-major
 * order. The requests depend only on the AOI and the entries. On failure the cache is discarded.
 */
export async function fetchEntries(aoi: Aoi, entries: AefEntry[], store: CacheStore, opts: Options = {}): Promise<RasterSource> {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.base ?? AEF_BASE;
  try {
    const cogs: { cog: RemoteCog; at: Placement }[] = [];
    for (const e of entries) {
      const cog = await openRemoteCog(base + e.path, fetchFn, opts.blockSize);
      const { gt, width, height, bandCount, epsg } = cog.meta;
      const at = placeCog(aoi, gt, width, height);
      if (!at || epsg !== aoi.epsg) throw new AefGridError(e.path);
      if (bandCount !== AEF_BANDS) throw new Error(`AlphaEarth file ${e.path} has ${bandCount} bands, not ${AEF_BANDS}.`);
      cogs.push({ cog, at });
    }
    const across = Math.ceil(aoi.width / TILE_SIZE);
    const buf = new Int8Array(WINDOW_BYTES);
    for (const win of tileWindows(aoi.width, aoi.height)) {
      buf.fill(AEF_NODATA_Q); // pixels no COG covers stay no data
      for (const { cog, at } of cogs) {
        const o = overlapWindow(at, win);
        if (!o) continue;
        const bands = await readInt8(cog, o.src);
        bands.forEach((b, k) => pasteBand(buf.subarray(k * TILE_SIZE * TILE_SIZE, (k + 1) * TILE_SIZE * TILE_SIZE), TILE_SIZE, b, o));
      }
      await store.write((win.y0 / TILE_SIZE) * across + win.x0 / TILE_SIZE, buf);
    }
    return cacheSource(aoi, store);
  } catch (e) {
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
