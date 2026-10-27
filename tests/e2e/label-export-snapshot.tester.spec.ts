import { expect, test } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { decodeClasses, CLASS_ITEM } from "../../src/core/classTable";
import { jumpTo, message, openApp, openRaster, path, rgbFixture, selectClass, stroke, toScreen } from "./helpers";
import { arrayBuffer, noSavePicker, storeTiles } from "./seeding";

// Tester probe of Export labels' snapshot (spec 004 Rules: Export labels; criterion 11's "saves and
// loads labels exactly"; ADR 0013: values are class index + 1 of the file's own table).
// The implementer's note: Export copies only the tile map and class list at the click, so a stroke
// during the write can still change a stored tile that hasn't been written yet.

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

test("labels edited while Export writes don't change the file: it holds the labels and classes at the click", async ({ page }) => {
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
  // Erase half of the Class 1 stroke, then paint a class added after the click over the other half.
  await stroke(page, path(a, await toScreen(page, [16.4, 43.6]), 6), "right");
  await page.click("#class-add"); // Class 3, not in the click's list
  await selectClass(page, 2);
  await stroke(page, path(await toScreen(page, [16.45, 43.6]), b, 6));
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
});
