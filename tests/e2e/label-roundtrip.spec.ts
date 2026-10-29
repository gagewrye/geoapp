import { expect, test } from "@playwright/test";
import { jumpTo, labels, message, openApp, openRaster, path, renameClass, selectClass, stroke, toScreen } from "./helpers";
import { classList, download, effectiveTiles, expectNoNodata, importFile, inNodata, noSavePicker, nodataImagery, storeTiles, upload } from "./seeding";

// Spec 004 criterion 11: Export labels, then Import labels, saves and loads labels exactly.

test("export then import restores every tile byte for byte and the class list, with no label on imagery nodata", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await openApp(page);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [14.3, 45.75], 8);
  await page.click("#brush-larger"); // size 15
  await page.click("#class-add"); // Class 3
  // three classes, each stroke crossing the nodata block (14.0..14.6E, 45.5..46.0N)
  for (const [i, lat] of [[0, 45.9], [1, 45.75], [2, 45.6]] as const) {
    await selectClass(page, i);
    await stroke(page, path(await toScreen(page, [13.8, lat]), await toScreen(page, [14.8, lat]), 12));
  }
  await page.click("#class-add"); // Class 4, unused
  await renameClass(page, 1, "Mangrove & <salt>");
  await page.locator("#classes .class-colour").nth(2).fill("#12ab34");
  const tiles = await storeTiles(page);
  const list = await classList(page);
  expect(list.map((c) => c.name)).toEqual(["Class 1", "Mangrove & <salt>", "Class 3", "Class 4"]);
  expect(list[2]!.colour).toBe("#12ab34");
  expect(new Set((await labels(page)).values())).toEqual(new Set([1, 2, 3]));
  expectNoNodata(tiles, 1000, inNodata);
  // the strokes reach both sides of the block
  const cols = [...(await labels(page)).keys()].map((k) => Number(k.split(",")[0]));
  expect(Math.min(...cols)).toBeLessThan(400);
  expect(Math.max(...cols)).toBeGreaterThanOrEqual(460);

  const file = await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");

  page.once("dialog", (d) => { expect(d.message()).toBe("Discard labels?"); void d.accept(); });
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  expect((await storeTiles(page)).size).toBe(0);
  await renameClass(page, 0, "scratch"); // so the list below can only come from the file
  page.on("dialog", (d) => { throw new Error(`unexpected dialog ${d.message()}`); });
  await importFile(page, upload("labels.tif", file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer));
  const n = [...tiles.values()].reduce((s, t) => s + t.filter((v) => v).length, 0);
  await expect(message(page)).toHaveText(`Seeded ${n} pixels in 3 classes.`);
  const back = await effectiveTiles(page); // spec 014: the file is a base
  expect([...back.keys()].sort()).toEqual([...tiles.keys()].sort());
  for (const [k, t] of tiles) expect(Buffer.from(back.get(k)!).equals(Buffer.from(t)), k).toBe(true);
  expectNoNodata(back, 1000, inNodata);
  expect(await classList(page)).toEqual(list);
  await expect(page.locator("#classes .class-name").nth(1)).toHaveValue("Mangrove & <salt>");
});
