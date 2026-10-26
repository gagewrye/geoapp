import { AEF_BANDS, dequantize, type Aoi } from "../core/aef";
import { TILE_SIZE } from "../core/types";
import type { GeoTags, RasterSource } from "./source";

/** One cached window: Int8 [64][256][256], band-sequential, no data -128 (4 MiB). */
export const WINDOW_BYTES = AEF_BANDS * TILE_SIZE * TILE_SIZE;

/** Where downloaded AOI windows live; index = row-major position in the 256x256 grid. */
export interface CacheStore {
  write(i: number, data: Int8Array): Promise<void>;
  read(i: number): Promise<Int8Array>;
  /** Delete every cached window. */
  discard(): Promise<void>;
}

/** In-memory store for tests; counts writes and records a discard. */
export function memoryStore() {
  const windows = new Map<number, Int8Array>();
  const store = {
    windows, writes: 0, discarded: false,
    async write(i: number, data: Int8Array) { store.writes++; windows.set(i, data.slice()); },
    async read(i: number) {
      const w = windows.get(i);
      if (!w) throw new Error(`AlphaEarth cache has no window ${i}`);
      return w;
    },
    async discard() { store.discarded = true; windows.clear(); },
  };
  return store;
}

/** OPFS store (ADR 0005); opening it drops any earlier AOI's cache. */
export async function opfsStore(name = "aef-cache"): Promise<CacheStore> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name, { recursive: true }).catch(() => {}); // absent on first use
  const dir = await root.getDirectoryHandle(name, { create: true });
  const file = (i: number) => `w${i}.i8`;
  return {
    async write(i, data) {
      const w = await (await dir.getFileHandle(file(i), { create: true })).createWritable();
      await w.write(data as Int8Array<ArrayBuffer>);
      await w.close();
    },
    async read(i) {
      return new Int8Array(await (await (await dir.getFileHandle(file(i))).getFile()).arrayBuffer());
    },
    async discard() {
      await root.removeEntry(name, { recursive: true });
    },
  };
}

/** GeoTIFF tags for a north-up WGS84 UTM grid, so exports carry the AOI's georeferencing. */
export function utmGeoTags(aoi: Aoi): GeoTags {
  return {
    GeoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, aoi.epsg],
    ModelPixelScale: [aoi.gt[1], -aoi.gt[5], 0],
    ModelTiepoint: [0, 0, 0, aoi.gt[0], aoi.gt[3], 0],
  };
}

/** The cached AOI as a raster: reads one grid window from the store and dequantizes it. */
export function cacheSource(aoi: Aoi, store: CacheStore): RasterSource {
  const across = Math.ceil(aoi.width / TILE_SIZE);
  return {
    meta: { width: aoi.width, height: aoi.height, bandCount: AEF_BANDS, gt: aoi.gt, epsg: aoi.epsg, nodata: null, geoTags: utmGeoTags(aoi) },
    async readWindow(x0, y0, width, height) {
      // the pipeline reads only grid windows (spec 001), so each read is one cached window
      if (x0 % TILE_SIZE || y0 % TILE_SIZE || width > TILE_SIZE || height > TILE_SIZE || x0 + width > aoi.width || y0 + height > aoi.height) {
        throw new Error(`AlphaEarth cache reads 256x256 grid windows, not ${width}x${height} at ${x0},${y0}`);
      }
      const q = await store.read((y0 / TILE_SIZE) * across + x0 / TILE_SIZE);
      const part = new Int8Array(width * height);
      const bands = Array.from({ length: AEF_BANDS }, (_, k) => {
        for (let r = 0; r < height; r++) part.set(q.subarray(k * TILE_SIZE * TILE_SIZE + r * TILE_SIZE, k * TILE_SIZE * TILE_SIZE + r * TILE_SIZE + width), r * width);
        const out = new Float32Array(width * height);
        dequantize(part, out);
        return out;
      });
      return { x0, y0, width, height, bands, nodata: null };
    },
  };
}
