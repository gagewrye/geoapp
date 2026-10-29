import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { collectErrors, message, openApp, openRaster, rgbFixture } from "./helpers";
import { classList, importFile, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

// Spec 003's rule for replaced rasters, applied to spec 004's Import labels:
// a run finishing after another raster opened sets no labels and no message, and the store isn't swapped.

async function reopen(page: Page) {
  page.once("dialog", (d) => void d.accept()); // Discard labels?
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(page.locator("#import-labels")).toBeEnabled(); // the new raster's controls are free at once
  await expect(page.locator("#classes .class-name").first()).toBeEnabled();
}
async function expectDropped(page: Page, list: unknown) {
  await page.waitForTimeout(500);
  await expect(message(page)).toHaveText("Raster opened.");
  expect((await storeTiles(page)).size).toBe(0);
  expect(await classList(page)).toEqual(list);
}

test("an import whose raster was replaced while it ran changes nothing on the new raster", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  const list = await classList(page);
  await reopen(page);
  await openFileGate(page);
  await expectDropped(page, list);
  expect(errors).toEqual([]);
});
