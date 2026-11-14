import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import type { LabelClass } from "../../src/core/classes";
import type { LabelStore } from "../../src/core/labelStore";
import type { Grid } from "../../src/core/types";
import { writeFile } from "../unit/helpers/labelFiles";
import { tiledGeotiffBuffer } from "../unit/helpers/tiledTiff";
import { once, RGB_GRID, type LngLat } from "./helpers";

// Spec 004 e2e helpers: label files as uploads, the store and list through the hook, downloads, gates.

export const upload = (name: string, data: ArrayBuffer | string) =>
  ({ name, mimeType: typeof data === "string" ? "application/json" : "image/tiff", buffer: Buffer.from(typeof data === "string" ? data : new Uint8Array(data)) });

/** The generated mask on rgbFixture's grid: 16 x 16 px blocks of 0..3, GDAL_NODATA 0, so classes 1, 2, 3 are values 1, 2, 3 (spec 014 tests). */
export const maskValue = (c: number, r: number) => ((c >> 4) + (r >> 4)) % 4;
let defaultMask: ReturnType<typeof upload> | null = null; // built once per worker (spec 072)
export function maskFile(value: (c: number, r: number) => number = maskValue) {
  if (value === maskValue && defaultMask) return { ...defaultMask };
  const v = new Uint8Array(1000 * 1000);
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 1000; c++) v[r * 1000 + c] = value(c, r);
  const file = upload("mask.tif", writeFile(RGB_GRID, 1, v, "0", { GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 }));
  if (value === maskValue) defaultMask = file;
  return { ...file };
}
/** Lon/lat of rgbFixture pixel position (col, row may be fractional). */
export const at = (c: number, r: number): LngLat => [10 + c * 0.01, 50 - r * 0.01];

export const arrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Import a label file; doesn't wait for the run. */
export async function importFile(page: Page, file: ReturnType<typeof upload>): Promise<void> {
  await page.setInputFiles("#import-labels", file);
}

/** Apply class map with this JSON text (spec 047); doesn't wait for the message. */
export const applyMap = (page: Page, text: string) => page.setInputFiles("#class-map", upload("map.json", text));

/** The stored tiles through the hook, decoded from base64 in Node. */
export async function storeTiles(page: Page): Promise<Map<string, Uint8Array>> {
  const entries: [string, string][] = await page.evaluate(() => {
    const { store } = (window as any).__geoapp.labels;
    return [...(store.tiles as Map<string, Uint8Array>)].map(([k, t]) => {
      let s = "";
      for (let i = 0; i < t.length; i += 8192) s += String.fromCharCode(...t.subarray(i, i + 8192));
      return [k, btoa(s)] as [string, string];
    });
  });
  return new Map(entries.map(([k, b]) => [k, new Uint8Array(Buffer.from(b, "base64"))]));
}

/** Every window's effective tile (spec 014's tile(key): stored, else the mask's) that holds a label, by key. */
export async function effectiveTiles(page: Page): Promise<Map<string, Uint8Array>> {
  const entries: [string, string][] = await page.evaluate(async () => {
    const { store, tile } = (window as any).__geoapp.labels;
    const out: [string, string][] = [];
    for (let y0 = 0; y0 < store.height; y0 += 256) for (let x0 = 0; x0 < store.width; x0 += 256) {
      const t: Uint8Array | null = await tile(`${x0},${y0}`);
      if (!t || !t.some((v) => v)) continue;
      let s = "";
      for (let i = 0; i < t.length; i += 8192) s += String.fromCharCode(...t.subarray(i, i + 8192));
      out.push([`${x0},${y0}`, btoa(s)]);
    }
    return out;
  });
  return new Map(entries.map(([k, b]) => [k, new Uint8Array(Buffer.from(b, "base64"))]));
}

/** Keys whose tiles differ between two effectiveTiles results (byte compare, far cheaper than labels() on a full mask: spec 052). */
export const tileDiff = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string[] =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => !a.has(k) || !b.has(k) || !Buffer.from(a.get(k)!).equals(Buffer.from(b.get(k)!))).sort();

export const classList = (page: Page): Promise<LabelClass[]> =>
  page.evaluate(() => (window as any).__geoapp.labels.classes.map((c: LabelClass) => ({ ...c })));

/** Bytes of the file a click downloads (Save dialog removed, so the app downloads from OPFS). */
export async function download(page: Page, selector: string): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  return readFile((await dl.path())!);
}

/** Before page scripts run: no Save dialog, so exports download. */
export const noSavePicker = (page: Page) => page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });

/** Holds every read of the next opened label file until `openGate` (window.__fileGate counts them). */
export const pauseLabelFile = (page: Page) => page.evaluate(() => {
  const g = (window as any).__fileGate = { reads: 0, open: null as null | (() => void) };
  const wait = new Promise<void>((r) => { g.open = r; });
  (window as any).__geoapp.labelFile = (f: { read: (w: unknown) => Promise<Uint8Array> }) => {
    const read = f.read.bind(f);
    f.read = async (w) => { g.reads++; await wait; return read(w); };
  };
});
export const openFileGate = (page: Page) => page.evaluate(() => (window as any).__fileGate.open());

/** Holds every imagery read (whole windows and spec 020's sample reads) until `openImageryGate`. */
export const pauseImagery = (page: Page) => page.evaluate(() => {
  const s = (window as any).__geoapp.imagery();
  const g = (window as any).__gate = { reads: 0, open: null as null | (() => void) };
  const wait = new Promise<void>((r) => { g.open = r; });
  for (const m of ["readWindow", "readSamples"]) {
    if (!s[m]) continue;
    const read = s[m].bind(s);
    s[m] = async (...a: unknown[]) => { g.reads++; await wait; return read(...a); };
  }
});
/** Holds spec 023's background mask reads (call before opening the raster), so a stroke reads its own masks. */
export const holdMasks = (page: Page) => page.evaluate(() => { (window as any).__geoapp.pauseMasks = true; });
export const openImageryGate = (page: Page) => page.evaluate(() => (window as any).__gate.open());

/** Spec 001's EPSG:4326 fixture grid, with band 2 nodata (0) on a block the class rasters cover. */
export const ND_GRID: Grid = { width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] };
export const inNodata = (c: number, r: number) => c >= 400 && c < 460 && r >= 400 && r < 450; // 14.0..14.6E, 45.5..46.0N
// Uint8 in 256 px tiles, built once per worker (spec 072), so its nodata is 0 rather than the Float32 strip's -9999
export const nodataImagery = once(() => ({ name: "nodata4326.tif", mimeType: "image/tiff", buffer: Buffer.from(tiledGeotiffBuffer(1000, 1000, 3,
  (b, c, r) => (b === 1 && inNodata(c, r) ? 0 : b === 0 ? (c < 500 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150),
  { epsg: 4326, gt: ND_GRID.gt, nodata: "0" }, { uint8: true })) }));

/** Each labelled pixel of these tiles (stored or effective, keyed "x0,y0") as [col, row, value], computed in Node (spec 072: no labels() scan). */
export function* labelled(tiles: Map<string, Uint8Array>, width: number): Generator<[number, number, number]> {
  for (const [key, t] of tiles) {
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    const w = Math.min(256, width - x0);
    for (let i = 0; i < t.length; i++) if (t[i]) yield [x0 + (i % w), y0 + Math.floor(i / w), t[i]!];
  }
}

/** Counts the paint ops strokes make from now on (window.__ops), through spec 023's paintOp hook; a locked stroke makes none, synchronously. */
export const countOps = (page: Page) => page.evaluate(() => { const w = window as any; w.__ops = 0; w.__geoapp.paintOp = () => { w.__ops++; }; });
export const opsCounted = (page: Page): Promise<number> => page.evaluate(() => (window as any).__ops);

/** The non-zero values of these tiles. */
export const valuesOf = (tiles: Map<string, Uint8Array>, width = 1000) => new Set([...labelled(tiles, width)].map(([, , v]) => v));

/** Every stored pixel is off imagery nodata. */
export function expectNoNodata(tiles: Map<string, Uint8Array>, width: number, nodata: (c: number, r: number) => boolean): void {
  let bad = 0;
  for (const [key, t] of tiles) {
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    const w = Math.min(256, width - x0);
    t.forEach((v, i) => { if (v && nodata(x0 + (i % w), y0 + Math.floor(i / w))) bad++; });
  }
  expect(bad).toBe(0);
}

/** Holds IndexedDB `get` on store sessions and `getAll`/`getAllKeys` on store tiles until each gate opens. */
export const holdIdb = () => {
  const w = window as any;
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  w.__idb = { get: gate(), tiles: gate() };
  const wrap = (name: "get" | "getAll" | "getAllKeys", store: string, which: "get" | "tiles") => {
    const real = IDBObjectStore.prototype[name] as (...a: unknown[]) => IDBRequest;
    (IDBObjectStore.prototype as any)[name] = function (this: IDBObjectStore, ...a: unknown[]) {
      const r = real.apply(this, a);
      if (this.name !== store) return r;
      return new Proxy(r, {
        set(t, k, v) {
          if (k === "onsuccess") (t as any).onsuccess = (e: Event) => { void w.__idb[which].p.then(() => v.call(t, e)); };
          else (t as any)[k] = v;
          return true;
        },
        get(t, k) { const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v; },
      });
    };
  };
  wrap("get", "sessions", "get");
  wrap("getAll", "tiles", "tiles");
  wrap("getAllKeys", "tiles", "tiles");
};

export type { LabelStore };
