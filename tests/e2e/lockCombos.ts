import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { CLASS_ITEM, decodeClasses } from "../../src/core/classTable";
import { tileWindows } from "../../src/core/grid";
import { message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";
import { arrayBuffer, holdMasks } from "./seeding";

// Helpers for smart-select and undo-seed (first written for spec 004's lock probes): an OPFS write gate, a two-class setup and a label file check.

export const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

/** Before page scripts: the OPFS writable's 2nd write overall waits for __writeGate.open() or fails on __writeGate.fail(msg). */
export const gateWrites = (page: Page) => page.addInitScript(() => {
  const g = (window as any).__writeGate = { writes: 0, waiting: false, open: null as null | (() => void), fail: null as null | ((m: string) => void) };
  const wait = new Promise<void>((res, rej) => { g.open = res; g.fail = (m: string) => rej(new Error(m)); });
  const proto = (window as any).FileSystemWritableFileStream.prototype;
  const write = proto.write;
  proto.write = async function (this: unknown, d: unknown) {
    if (++g.writes === 2) { g.waiting = true; await wait; }
    return write.call(this, d);
  };
});
export const writeHeld = (page: Page) => expect.poll(() => page.evaluate(() => (window as any).__writeGate.waiting)).toBe(true);
export const openWrite = (page: Page) => page.evaluate(() => (window as any).__writeGate.open());

/** Every 256x256 tile of a 1000x1000 label file, compared with stored tiles (zeros where none). */
export async function expectFileHolds(path: string, tiles: Map<string, Uint8Array>, names: string[]): Promise<void> {
  const image = await (await fromArrayBuffer(arrayBuffer(await readFile(path)))).getImage();
  const table = decodeClasses(((await image.getGDALMetadata()) as Record<string, string>)[CLASS_ITEM]!) as { name: string }[];
  expect(table.map((e) => e.name)).toEqual(names);
  for (const w of tileWindows(1000, 1000)) {
    const [px] = (await image.readRasters({ window: [w.x0, w.y0, w.x0 + w.width, w.y0 + w.height] })) as unknown as Uint8Array[];
    const want = tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height);
    expect(Buffer.from(px!).equals(Buffer.from(want)), `${w.x0},${w.y0}`).toBe(true);
  }
}

export async function setup(page: Page, raster = rgbFixture()) {
  await openApp(page);
  await holdMasks(page);
  await openRaster(page, raster);
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await paintTwoClasses(page);
}
