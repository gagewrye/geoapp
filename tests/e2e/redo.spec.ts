import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, paintMode, rgbFixture, settled, stroke, toScreen } from "./helpers";
import { download, noSavePicker } from "./seeding";

// Spec 037 criteria 6 and 8.
const exported = async (page: Page) => {
  const file = await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  return file;
};
const bounds = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getBounds().toArray().flat() as number[]);

test("3 strokes, 3 undos and 3 redos export the same file as the 3 strokes; Redo is then disabled (criterion 6)", async ({ page }) => {
  expect(1, "deliberate failure: spec 060 criterion 8 probe, never merge").toBe(2);
  await noSavePicker(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const redo = page.locator("#redo");
  await expect(redo).toBeDisabled();
  for (const [dx, dy] of [[0, 0], [30, 40], [-20, 80]] as const) {
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [{ x: c.x + dx, y: c.y + dy }, { x: c.x + dx + 60, y: c.y + dy + 10 }]);
    await settled(page);
  }
  const after3 = await exported(page);
  for (let i = 0; i < 3; i++) await page.click("#undo");
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(redo).toBeEnabled();
  // the button, Ctrl+Shift+Z and Ctrl+Y
  await redo.click();
  await page.locator("#map canvas").focus();
  await page.keyboard.press("Control+Shift+Z");
  await page.keyboard.press("Control+y");
  await expect(redo).toBeDisabled();
  await expect(page.locator("#undo")).toBeEnabled();
  expect((await exported(page)).equals(after3)).toBe(true);
});

test("Home with a checkbox focused fits the raster; with the opacity slider focused it moves the slider (criterion 8)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  const fitted = await bounds(page);
  await jumpTo(page, [40, 10], 9);
  await page.locator("#show-labels").focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => (await bounds(page)).every((v, i) => Math.abs(v - fitted[i]!) <= 1e-6)).toBe(true);
  await expect(page.locator("#show-labels")).toBeChecked();
  await jumpTo(page, [40, 10], 9);
  const away = await bounds(page);
  await page.locator("#label-opacity").focus();
  await page.keyboard.press("Home");
  await expect(page.locator("#label-opacity")).toHaveValue("0");
  await page.waitForTimeout(100);
  (await bounds(page)).forEach((v, i) => expect(Math.abs(v - away[i]!)).toBeLessThanOrEqual(1e-6));
});
