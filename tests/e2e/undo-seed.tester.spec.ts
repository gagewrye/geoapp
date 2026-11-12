import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { holdKeys, jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, stroke, toScreen, view, type Xy } from "./helpers";
import { expectFileHolds, gateWrites, openWrite, seeded, setup as twoClasses, writeHeld } from "./lockCombos";
import { importFile, noSavePicker, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

// Tester edge cases for spec 010 with spec 004 built: Replace clears, refused imports keep the history,
// and navigation, the cursor and Undo while labels are locked.
const undoButton = (page: Page) => page.locator("#undo");
const snapshot = async (page: Page) => [...(await labels(page))].sort();
const classes = () => upload("classes.tif", classFile("255"));
const mapMid = async (page: Page): Promise<Xy> => {
  const b = (await page.locator("#map canvas").boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

async function oneStroke(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const empty = await snapshot(page);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  await expect(undoButton(page)).toBeEnabled();
  return { empty, c };
}

test("while an import is paused: a drag paints nothing and adds no undo step; WASD and a middle drag still pan; the cursor stays", async ({ page }) => {
  const { c } = await oneStroke(page);
  await pauseLabelFile(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, classes());
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  const before = await snapshot(page);
  await page.mouse.move(c.x, c.y + 80);
  await page.mouse.down();
  await page.mouse.move(c.x + 80, c.y + 80);
  await page.mouse.up();
  expect(await snapshot(page)).toEqual(before);
  await expect(undoButton(page)).toBeDisabled();
  const v0 = await view(page);
  await holdKeys(page, ["KeyW"], { ms: 200, frames: 3 });
  const v1 = await view(page);
  expect(v1.lat).toBeGreaterThan(v0.lat);
  const m = await mapMid(page);
  await page.mouse.move(m.x, m.y);
  await page.mouse.down({ button: "middle" });
  for (let i = 1; i <= 5; i++) await page.mouse.move(m.x + 20 * i, m.y);
  await page.mouse.up({ button: "middle" });
  expect((await view(page)).lng).toBeLessThan(v1.lng);
  expect(await snapshot(page)).toEqual(before);
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expect(undoButton(page)).toBeDisabled(); // the import replaced the store
});

test("an Export labels run after an Undo writes the store as undone; the remaining step still undoes", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await twoClasses(page);
  await undoButton(page).click(); // the class 2 stroke
  const atClick = await storeTiles(page);
  const downloaded = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await expect(undoButton(page)).toBeDisabled();
  await openWrite(page);
  const dl = await downloaded;
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl.path())!, atClick, ["left", "right"]);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(await snapshot(page)).toEqual([]);
  await expect(undoButton(page)).toBeDisabled();
});
