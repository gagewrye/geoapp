import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { CLASS_ITEM, decodeClasses } from "../../src/core/classTable";
import { tileWindows } from "../../src/core/grid";
import { MESSAGES } from "../../src/ui/messages";
import { hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintTwoClasses, rgbFixture, toScreen } from "./helpers";
import { arrayBuffer, classList, noSavePicker, openImageryGate, pauseImagery, storeTiles } from "./seeding";

// Tester probe of spec 004's shared lock (Settled in build: Locks): while a seed or an Export labels
// run is active on the open imagery, the brush and class add, rename and recolour are locked, and
// only then. Exports, seeds, Trains, raster opens and Load model in combination; a cancelled Save
// dialog and a failed write must unlock.

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

/** Before page scripts: the OPFS writable's 2nd write overall waits for __writeGate.open() or fails on __writeGate.fail(msg). */
const gateWrites = (page: Page) => page.addInitScript(() => {
  const g = (window as any).__writeGate = { writes: 0, waiting: false, open: null as null | (() => void), fail: null as null | ((m: string) => void) };
  const wait = new Promise<void>((res, rej) => { g.open = res; g.fail = (m: string) => rej(new Error(m)); });
  const proto = (window as any).FileSystemWritableFileStream.prototype;
  const write = proto.write;
  proto.write = async function (this: unknown, d: unknown) {
    if (++g.writes === 2) { g.waiting = true; await wait; }
    return write.call(this, d);
  };
});
const writeHeld = (page: Page) => expect.poll(() => page.evaluate(() => (window as any).__writeGate.waiting)).toBe(true);
const openWrite = (page: Page) => page.evaluate(() => (window as any).__writeGate.open());

const PROBE: [number, number] = [15.505, 45.505]; // unlabelled by paintTwoClasses, tile 256,256

/** Locked: Add, every name and colour disabled, and no footprint at PROBE. Unlocked: all enabled and a footprint. */
async function expectLock(page: Page, on: boolean, why: string): Promise<void> {
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
async function drag(page: Page): Promise<void> {
  const p = await toScreen(page, PROBE);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y + 8, { steps: 4 });
  await page.mouse.up();
}

/** Every 256x256 tile of a 1000x1000 label file, compared with stored tiles (zeros where none). */
async function expectFileHolds(path: string, tiles: Map<string, Uint8Array>, names: string[]): Promise<void> {
  const image = await (await fromArrayBuffer(arrayBuffer(await readFile(path)))).getImage();
  const table = decodeClasses(((await image.getGDALMetadata()) as Record<string, string>)[CLASS_ITEM]!) as { name: string }[];
  expect(table.map((e) => e.name)).toEqual(names);
  for (const w of tileWindows(1000, 1000)) {
    const [px] = (await image.readRasters({ window: [w.x0, w.y0, w.x0 + w.width, w.y0 + w.height] })) as unknown as Uint8Array[];
    const want = tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height);
    expect(Buffer.from(px!).equals(Buffer.from(want)), `${w.x0},${w.y0}`).toBe(true);
  }
}

const opfsNames = (page: Page) => page.evaluate(async () => {
  const out: string[] = [];
  for await (const k of (await navigator.storage.getDirectory() as any).keys()) out.push(k as string);
  return out;
});

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintTwoClasses(page);
}
async function trained(page: Page) {
  await setup(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on/);
}
/** Opens another raster with the same grid, accepting "Discard labels?" if asked. */
async function reopen(page: Page) {
  page.once("dialog", (d) => void d.accept());
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 6);
}
const modelJson = (page: Page) => page.evaluate(() => JSON.stringify((window as any).__geoapp.model()));
const loadModel = (page: Page, json: string) =>
  page.setInputFiles("#load-model", { name: "model.json", mimeType: "application/json", buffer: Buffer.from(json) });

test("a Save dialog held open locks; cancelling it unlocks, and Export runs again", async ({ page }) => {
  await page.addInitScript(() => {
    const g = (window as any).__save = { opened: 0, cancel: null as null | (() => void) };
    (window as any).showSaveFilePicker = () => new Promise((_, rej) => {
      g.opened++;
      g.cancel = () => rej(new DOMException("The user aborted a request.", "AbortError"));
    });
  });
  await setup(page);
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__save.opened)).toBe(1);
  await expect(page.locator("#export-labels")).toBeDisabled();
  await expectLock(page, true, "dialog open");
  await page.evaluate(() => (window as any).__save.cancel());
  await expect(message(page)).toHaveText("The user aborted a request.");
  await expect(page.locator("#export-labels")).toBeEnabled();
  await expectLock(page, false, "dialog cancelled");
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__save.opened)).toBe(2);
  await page.evaluate(() => (window as any).__save.cancel());
  await expectLock(page, false, "second dialog cancelled");
});

test("a write that fails unlocks, leaves no file, and a retry exports the labels", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  await page.click("#export-labels");
  await writeHeld(page);
  await expect(page.locator("#export-labels")).toBeDisabled(); // one at a time
  await expectLock(page, true, "write held");
  await page.evaluate(() => (window as any).__writeGate.fail("disk full"));
  await expect(message(page)).toHaveText("disk full");
  await expect(page.locator("#export-labels")).toBeEnabled();
  await expectLock(page, false, "write failed");
  expect(await opfsNames(page)).toEqual([]);
  const tiles = await storeTiles(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-labels")]);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl.path())!, tiles, ["left", "right"]);
});

test("Export is a no-op while the paint queue is non-empty, even if its button is forced enabled", async ({ page }) => {
  await page.addInitScript(() => {
    const g = (window as any).__save = { opened: 0 };
    (window as any).showSaveFilePicker = () => { g.opened++; return new Promise(() => {}); };
  });
  await setup(page);
  await pauseImagery(page);
  await jumpTo(page, [11.5, 48.5], 6);
  const b = await toScreen(page, [11.505, 48.505]); // tile 0,0: no mask yet, so the dab waits for a read
  await page.mouse.click(b.x, b.y);
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await expect(page.locator("#export-labels")).toBeDisabled();
  await page.evaluate(() => { const e = document.getElementById("export-labels") as HTMLButtonElement; e.disabled = false; e.click(); });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__save.opened)).toBe(0);
  await expect(page.locator("#class-add")).toBeEnabled(); // no lock either
  await openImageryGate(page);
  await expect(page.locator("#export-labels")).toBeEnabled();
});

test("another raster opened mid-export is unlocked at once; Export waits for the old write, whose file holds the old labels", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  const tiles = await storeTiles(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await expectLock(page, true, "export on A");
  await reopen(page);
  await expectLock(page, false, "B opened");
  await expect(page.locator("#export-labels")).toBeDisabled(); // A's write still runs: one at a time
  // B can be painted while A writes
  await drag(page);
  await expect.poll(async () => (await labels(page)).size).toBeGreaterThan(0);
  const onB = await storeTiles(page);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expect(page.locator("#export-labels")).toBeEnabled();
  await expectLock(page, false, "A's export ended");
  expect(await storeTiles(page)).toEqual(onB);
});

test("Load model and a seed on a raster opened mid-export: A's write ending keeps B locked while B's seed runs", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  const json = await modelJson(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await reopen(page);
  await loadModel(page, json); // Load model during A's export
  await expect(message(page)).toHaveText("Loaded model with classes: left, right.");
  await expect(page.locator("#seed-model")).toBeEnabled();
  await pauseImagery(page); // B's reads
  await page.click("#seed-model"); // no labels on B: replaces, no confirm
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await expectLock(page, true, "B seeding");
  await openWrite(page);
  await dl;
  await expect(message(page)).toHaveText("Labels exported.");
  await expectLock(page, true, "A's export ended, B's seed still runs");
  await expect(page.locator("#train")).toBeDisabled();
  await openImageryGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expectLock(page, false, "B's seed ended");
});

test("a stale seed dropping on a raster whose export runs keeps the export's lock; the export ending lifts it", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  await pauseImagery(page); // A's reads
  await page.click("#seed-model"); // Merge: no confirm
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await reopen(page);
  await expectLock(page, false, "B opened mid-seed");
  const dl = page.waitForEvent("download");
  const list = (await classList(page)).map((c) => c.name); // the list outlives a raster open
  await page.click("#export-labels"); // B has no labels: an all-zero file
  await writeHeld(page);
  await expectLock(page, true, "export on B");
  await openImageryGate(page); // A's seed sees it is stale and drops
  await page.waitForTimeout(500);
  await expectLock(page, true, "A's seed dropped, B's export runs");
  expect((await storeTiles(page)).size).toBe(0);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, new Map(), list);
  await expectLock(page, false, "B's export ended");
});

test("a Merge seed during an export: the lock outlasts the seed, the file holds the click's labels and classes", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  const tiles = await storeTiles(page);
  const json = await modelJson(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  // a model loaded mid-export with other names: a Merge seed appends them
  await loadModel(page, JSON.stringify({ ...JSON.parse(json), classes: ["p", "q"] }));
  await expect(message(page)).toHaveText("Loaded model with classes: p, q.");
  await page.click("#seed-model");
  await expect(message(page)).toHaveText(seeded);
  expect((await classList(page)).map((c) => c.name)).toEqual(["left", "right", "p", "q"]);
  await expectLock(page, true, "seed ended, export runs");
  const seededTiles = await storeTiles(page);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended");
  expect(await storeTiles(page)).toEqual(seededTiles);
});

test("a Train during an export, and an export during a Train: only the export locks, and it reads no imagery", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  const tiles = await storeTiles(page);
  await pauseImagery(page);
  await page.click("#train");
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBeGreaterThan(0);
  await expectLock(page, false, "Train runs");
  const dl1 = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await expectLock(page, true, "export during Train");
  await openImageryGate(page);
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
  await expectLock(page, true, "Train ended, export runs");
  await openWrite(page);
  await expectFileHolds((await (await dl1).path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended");

  // an export started and finished while a Train's imagery reads are held
  await pauseImagery(page);
  await page.click("#train");
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBeGreaterThan(0);
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#export-labels")]);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl2.path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended, Train still runs");
  await openImageryGate(page);
  await expect(message(page)).toHaveText(/^Trained on/);
});

test("a raster open cancelled at Discard labels? mid-export keeps the lock until the write ends", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  const tiles = await storeTiles(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect.poll(() => asked).toEqual([MESSAGES.discard]);
  await expectLock(page, true, "open cancelled");
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended");
});

test("a seed started during an export on the same raster: the export ending keeps the lock until the seed ends", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  const tiles = await storeTiles(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await pauseImagery(page);
  await page.click("#seed-model"); // Merge: no confirm
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectLock(page, true, "export ended, seed runs");
  await expect(page.locator("#export-labels")).toBeDisabled(); // while seeding
  await openImageryGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expectLock(page, false, "seed ended");
  await expect(page.locator("#export-labels")).toBeEnabled();
});
