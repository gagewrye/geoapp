import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { CLASS_ITEM, decodeClasses } from "../../src/core/classTable";
import { tileWindows } from "../../src/core/grid";
import { hoverFeatures, jumpTo, message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture, toScreen } from "./helpers";
import { arrayBuffer } from "./seeding";

// Helpers for the label-lock-*.tester specs.
// Tester probe of spec 004's shared lock (Settled in build: Locks): while a seed or an Export labels
// run is active on the open imagery, the brush and class add, rename and recolour are locked, and
// only then. Exports, seeds and raster opens in combination; a cancelled Save dialog and a failed
// write must unlock.

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

const PROBE: [number, number] = [15.505, 45.505]; // unlabelled by paintTwoClasses, tile 256,256

/** Locked: Add, every name and colour disabled, and no footprint at PROBE. Unlocked: all enabled and a footprint. */
export async function expectLock(page: Page, on: boolean, why: string): Promise<void> {
  const state = (l: ReturnType<Page["locator"]>) => (on ? expect(l, why).toBeDisabled() : expect(l, why).toBeEnabled());
  await state(page.locator("#class-add"));
  for (const sel of ["#classes .class-name", "#classes .class-colour"]) {
    const n = await page.locator(sel).count();
    for (let i = 0; i < n; i++) await state(page.locator(sel).nth(i));
  }
  const p = await toScreen(page, PROBE);
  await page.mouse.move(p.x, p.y);
  await page.mouse.move(p.x + 1, p.y);
  if (on) {
    await page.waitForTimeout(150);
    expect(await hoverFeatures(page), why).toEqual([]);
  } else {
    await expect.poll(async () => (await hoverFeatures(page)).length, { message: why }).toBe(1);
  }
}

/** A left drag at PROBE that waits for no control; resolves once the mouse is up. */
export async function drag(page: Page): Promise<void> {
  const p = await toScreen(page, PROBE);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y + 8, { steps: 4 });
  await page.mouse.up();
}

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

export const opfsNames = (page: Page) => page.evaluate(async () => {
  const out: string[] = [];
  for await (const k of (await navigator.storage.getDirectory() as any).keys()) out.push(k as string);
  return out;
});

export async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await paintTwoClasses(page);
}
/** Opens another raster with the same grid, accepting "Discard labels?" if asked. */
export async function reopen(page: Page) {
  page.once("dialog", (d) => void d.accept());
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 6);
}
