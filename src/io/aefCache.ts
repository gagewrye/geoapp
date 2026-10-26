import { AEF_BANDS, dequantize, type Aoi } from "../core/aef";
import { TILE_SIZE } from "../core/types";
import type { GeoTags, RasterSource } from "./source";

/** One band of one cached window: Int8 [256][256], no data -128, edge windows padded (64 KiB). */
export const PLANE_BYTES = TILE_SIZE * TILE_SIZE;

/** Appends one band's window planes, in row-major window order. */
export interface BandWriter {
  append(plane: Int8Array): Promise<void>;
  close(): Promise<void>;
  /** Give up on this band; the download is being discarded. */
  abort(): Promise<void>;
}

/** Where a downloaded AOI lives: one file per band, plane i at byte i x 64 KiB (spec 002). */
export interface CacheStore {
  /** Start band b's file; each band is written by one writer, once. */
  band(b: number): Promise<BandWriter>;
  /** The 64 band planes of window i (row-major position in the 256x256 grid). */
  read(i: number): Promise<Int8Array[]>;
  /** Delete every cached band. */
  discard(): Promise<void>;
}

/** In-memory store for tests; counts plane writes and records a discard. */
export function memoryStore() {
  const files = new Map<number, Int8Array[]>();
  const store = {
    files, writes: 0, discarded: false,
    async band(b: number): Promise<BandWriter> {
      if (files.has(b)) throw new Error(`AlphaEarth cache band ${b} written twice`);
      const planes: Int8Array[] = [];
      files.set(b, planes);
      return {
        async append(plane) { store.writes++; planes.push(plane.slice()); },
        async close() {},
        async abort() {},
      };
    },
    async read(i: number) {
      return Array.from({ length: AEF_BANDS }, (_, b) => {
        const plane = files.get(b)?.[i];
        if (!plane) throw new Error(`AlphaEarth cache has no window ${i}`);
        return plane;
      });
    },
    async discard() { store.discarded = true; files.clear(); },
  };
  return store;
}

/** OPFS store (ADR 0005); opening it drops any earlier AOI's cache. `root` is for tests. */
export async function opfsStore(name = "aef-cache", root?: FileSystemDirectoryHandle): Promise<CacheStore> {
  const top = root ?? await navigator.storage.getDirectory();
  await top.removeEntry(name, { recursive: true }).catch(() => {}); // absent on first use
  const dir = await top.getDirectoryHandle(name, { create: true });
  const file = (b: number) => `b${b}.i8`;
  return {
    async band(b) {
      // one writable per band: every byte is written once, with no read-modify-write
      const w = await (await dir.getFileHandle(file(b), { create: true })).createWritable();
      return {
        append: (plane) => w.write(plane as Int8Array<ArrayBuffer>),
        close: () => w.close(),
        abort: () => w.abort(),
      };
    },
    async read(i) {
      return Promise.all(Array.from({ length: AEF_BANDS }, async (_, b) => {
        const f = await (await dir.getFileHandle(file(b))).getFile();
        const plane = new Int8Array(await f.slice(i * PLANE_BYTES, (i + 1) * PLANE_BYTES).arrayBuffer());
        if (plane.length !== PLANE_BYTES) throw new Error(`AlphaEarth cache has no window ${i}`);
        return plane;
      }));
    },
    async discard() {
      await top.removeEntry(name, { recursive: true });
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

/** The cached AOI as a raster: reads one grid window's 64 planes from the store and dequantizes them. */
export function cacheSource(aoi: Aoi, store: CacheStore): RasterSource {
  const across = Math.ceil(aoi.width / TILE_SIZE);
  return {
    meta: { width: aoi.width, height: aoi.height, bandCount: AEF_BANDS, gt: aoi.gt, epsg: aoi.epsg, nodata: null, geoTags: utmGeoTags(aoi) },
    async readWindow(x0, y0, width, height) {
      // the pipeline reads only grid windows (spec 001), so each read is one cached window
      if (x0 % TILE_SIZE || y0 % TILE_SIZE || width > TILE_SIZE || height > TILE_SIZE || x0 + width > aoi.width || y0 + height > aoi.height) {
        throw new Error(`AlphaEarth cache reads 256x256 grid windows, not ${width}x${height} at ${x0},${y0}`);
      }
      const planes = await store.read((y0 / TILE_SIZE) * across + x0 / TILE_SIZE);
      const part = new Int8Array(width * height);
      const bands = planes.map((q) => {
        for (let r = 0; r < height; r++) part.set(q.subarray(r * TILE_SIZE, r * TILE_SIZE + width), r * width);
        const out = new Float32Array(width * height);
        dequantize(part, out);
        return out;
      });
      return { x0, y0, width, height, bands, nodata: null };
    },
  };
}
