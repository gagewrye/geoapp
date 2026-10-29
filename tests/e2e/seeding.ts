import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import type { LabelClass } from "../../src/core/classes";
import type { LabelStore } from "../../src/core/labelStore";
import type { Grid } from "../../src/core/types";
import { tiff } from "./helpers";

// Spec 004 e2e helpers: label files as uploads, the store and list through the hook, downloads, gates.

export const upload = (name: string, data: ArrayBuffer | string) =>
  ({ name, mimeType: typeof data === "string" ? "application/json" : "image/tiff", buffer: Buffer.from(typeof data === "string" ? data : new Uint8Array(data)) });

export const arrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Import a label file, with a class map when given; doesn't wait for the run. */
export async function importFile(page: Page, file: ReturnType<typeof upload>, classMap?: ReturnType<typeof upload>): Promise<void> {
  if (classMap) await page.setInputFiles("#class-map", classMap);
  await page.setInputFiles("#import-labels", file);
}

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

/** Holds every imagery read until `openImageryGate`. */
export const pauseImagery = (page: Page) => page.evaluate(() => {
  const s = (window as any).__geoapp.imagery();
  const read = s.readWindow.bind(s);
  const g = (window as any).__gate = { reads: 0, open: null as null | (() => void) };
  const wait = new Promise<void>((r) => { g.open = r; });
  s.readWindow = async (...a: unknown[]) => { g.reads++; await wait; return read(...a); };
});
export const openImageryGate = (page: Page) => page.evaluate(() => (window as any).__gate.open());

/** Spec 001's EPSG:4326 fixture grid, with band 2 nodata (-9999) on a block the class rasters cover. */
export const ND_GRID: Grid = { width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] };
export const inNodata = (c: number, r: number) => c >= 400 && c < 460 && r >= 400 && r < 450; // 14.0..14.6E, 45.5..46.0N
export const nodataImagery = () => tiff("nodata4326.tif", 1000, 1000, 3,
  (b, c, r) => (b === 1 && inNodata(c, r) ? -9999 : b === 0 ? (c < 500 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150),
  { epsg: 4326, gt: ND_GRID.gt, nodata: "-9999" });

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

export type { LabelStore };
