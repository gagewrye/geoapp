import { expect, test } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { decodeClasses, CLASS_ITEM } from "../../src/core/classTable";
import { hoverFeatures, jumpTo, message, openApp, openRaster, path, rgbFixture, selectClass, stroke, toScreen } from "./helpers";
import { arrayBuffer, noSavePicker, storeTiles } from "./seeding";

// Tester probe of Export labels' snapshot (spec 004 Rules: Export labels; criterion 11's "saves and
// loads labels exactly"; ADR 0013: values are class index + 1 of the file's own table).
// Export snapshots the tile map and class list at the click and, until the write ends, locks the
// brush and class edits as seeding does, so no stored tile changes in place under the write.

/** Before page scripts: the OPFS writable's 2nd write (the first tile, after the header) waits for __writeGate.open(). */
const gateWrites = (page: import("@playwright/test").Page) => page.addInitScript(() => {
  const g = (window as any).__writeGate = { writes: 0, waiting: false, open: null as null | (() => void) };
  const wait = new Promise<void>((r) => { g.open = r; });
  const proto = (window as any).FileSystemWritableFileStream.prototype;
  const write = proto.write;
  proto.write = async function (this: unknown, d: unknown) {
    if (++g.writes === 2) { g.waiting = true; await wait; }
    return write.call(this, d);
  };
});

test("while Export writes, strokes and class edits are refused, so the file holds the labels and classes at the click", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  // Class 1 across tile 512,512 (lon 15.12..17.68E, lat 42.33..44.88N), centred on pixel 640,640
  await jumpTo(page, [16.4, 43.6], 7);
  await page.click("#brush-larger"); // 15 px
  await selectClass(page, 0);
  const a = await toScreen(page, [16.0, 43.6]), b = await toScreen(page, [16.8, 43.6]);
  await stroke(page, path(a, b, 10));
  const before = await storeTiles(page);
  expect([...before.keys()]).toEqual(["512,512"]);
  const tile = before.get("512,512")!;
  expect(tile.filter((v) => v === 1).length).toBeGreaterThan(1000);

  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__writeGate.waiting)).toBe(true);
  // header written, tile 0,0 waiting: tile 512,512 hasn't been read for the file yet.
  // Class edits are off (selecting still works), and erasing or painting over the stroke changes nothing.
  await expect(page.locator("#class-add")).toBeDisabled();
  for (const sel of ["#classes .class-name", "#classes .class-colour"]) {
    const n = await page.locator(sel).count();
    for (let i = 0; i < n; i++) await expect(page.locator(sel).nth(i)).toBeDisabled();
  }
  await selectClass(page, 1);
  await expect(page.locator("#classes li").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.mouse.move(a.x, a.y);
  expect(await hoverFeatures(page)).toEqual([]); // no footprint
  await stroke(page, path(a, await toScreen(page, [16.4, 43.6]), 6), "right");
  await stroke(page, path(await toScreen(page, [16.45, 43.6]), b, 6));
  const during = await storeTiles(page);
  expect([...during.keys()]).toEqual(["512,512"]);
  expect(Buffer.from(during.get("512,512")!).equals(Buffer.from(tile))).toBe(true);
  await page.evaluate(() => (window as any).__writeGate.open());
  const file = await (await dl).path();
  await expect(message(page)).toHaveText("Labels exported.");

  const { readFile } = await import("node:fs/promises");
  const image = await (await fromArrayBuffer(arrayBuffer(await readFile(file!)))).getImage();
  const table = decodeClasses(((await image.getGDALMetadata()) as Record<string, string>)[CLASS_ITEM]!) as { value: number }[];
  expect(table.map((e) => e.value)).toEqual([1, 2]); // the list at the click
  const [px] = (await image.readRasters({ window: [512, 512, 768, 768] })) as unknown as Uint8Array[];
  // every pixel value has a class in the file's own table
  expect(Math.max(...px!)).toBeLessThanOrEqual(table.length);
  // and the tile is the one stored at the click
  expect(Buffer.from(px!).equals(Buffer.from(tile))).toBe(true);

  // the lock ends with the export: a class can be added and a right drag erases again
  await expect(page.locator("#class-add")).toBeEnabled();
  await selectClass(page, 0); // a right drag erases the selected class
  await stroke(page, path(a, await toScreen(page, [16.4, 43.6]), 6), "right");
  await expect.poll(async () => (await storeTiles(page)).get("512,512")?.filter((v) => v === 1).length ?? 0).toBeLessThan(tile.filter((v) => v === 1).length);
});
