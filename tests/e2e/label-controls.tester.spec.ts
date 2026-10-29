import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { MESSAGES } from "../../src/ui/messages";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, paintTwoClasses, rgbFixture, stroke, toScreen } from "./helpers";
import { classList, importFile, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

// Tester checks of spec 004's controls: Seed mode after erasing everything, the replaced-raster
// rule for an import that fails, and a run that survives a cancelled "Discard labels?".

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("erasing every label disables Seed mode again and resets it to Merge", async ({ page }) => {
  await setup(page);
  await jumpTo(page, [15, 45], 7);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 20, y: a.y }]);
  await expect(page.locator("#seed-mode")).toBeEnabled();
  await page.selectOption("#seed-mode", "replace");
  await page.click("#brush-larger"); await page.click("#brush-larger"); await page.click("#brush-larger");
  await stroke(page, [{ x: a.x - 10, y: a.y }, { x: a.x + 30, y: a.y }], "right");
  expect((await labels(page)).size).toBe(0);
  await expect(page.locator("#seed-mode")).toBeDisabled();
  await expect(page.locator("#seed-mode")).toHaveValue("merge");
  // and the next import replaces with no confirm
  page.on("dialog", (d) => { throw new Error(`unexpected dialog ${d.message()}`); });
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
});

test("an import that fails after another raster opened shows no message and changes nothing (spec 003's replaced-raster rule)", async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page);
  // the next opened label file's reads wait, then fail
  await page.evaluate(() => {
    const g = (window as any).__fileGate = { reads: 0, open: null as null | (() => void) };
    const wait = new Promise<void>((r) => { g.open = r; });
    (window as any).__geoapp.labelFile = (f: { read: (w: unknown) => Promise<Uint8Array> }) => {
      f.read = async () => { g.reads++; await wait; throw new Error("read failed"); };
    };
  });
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  const list = await classList(page);
  await openRaster(page, { ...rgbFixture(), name: "other.tif" }); // no labels: no confirm
  await expect(message(page)).toHaveText("Raster opened.");
  await openFileGate(page);
  await page.waitForTimeout(500);
  await expect(message(page)).toHaveText("Raster opened.");
  expect((await storeTiles(page)).size).toBe(0);
  expect(await classList(page)).toEqual(list);
  await expect(page.locator("#import-labels")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("a run whose raster stays because Discard labels? was cancelled still applies", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  const painted = await labels(page);
  await pauseLabelFile(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect.poll(() => asked).toEqual([MESSAGES.discard]);
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  const after = await labels(page);
  expect(after.size).toBeGreaterThan(painted.size);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]); // it replaced
});
