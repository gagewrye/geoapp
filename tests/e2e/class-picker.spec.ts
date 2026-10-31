import { expect, test, type Page } from "@playwright/test";
import { jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, selectClass, settled, stroke, tileKeysStored, toScreen } from "./helpers";
import { at, importFile, maskFile, maskValue } from "./seeding";

// Spec 038 criteria 4 and 5.
const selected = (page: Page) => page.locator("#classes li").evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));
const altClick = async (page: Page, p: { x: number; y: number }) => {
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Alt");
};

async function paintClass2(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  await selectClass(page, 1);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 40, y: c.y }]);
  await settled(page);
  await selectClass(page, 0);
  return { c: { x: c.x + 20, y: c.y }, before: await labels(page) };
}

test("Alt+click on a class 2 pixel selects class 2, keeps Paint and changes no label (criterion 4)", async ({ page }) => {
  const { c, before } = await paintClass2(page);
  await altClick(page, c);
  await expect(message(page)).toHaveText("Picked Class 2.");
  expect(await selected(page)).toBe(1);
  await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(100);
  expect(await labels(page)).toEqual(before);
});

test("I over a class 2 pixel selects class 2; over an unlabelled one it says No label here. (criterion 4)", async ({ page }) => {
  const { c, before } = await paintClass2(page);
  await page.locator("#map canvas").focus();
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press("i");
  await expect(message(page)).toHaveText("Picked Class 2.");
  expect(await selected(page)).toBe(1);
  expect(await labels(page)).toEqual(before);
  await page.mouse.move(c.x, c.y + 120);
  await page.keyboard.press("i");
  await expect(message(page)).toHaveText("No label here.");
  expect(await selected(page)).toBe(1);
});

test("after importing the mask, Alt+click on a mask-only pixel of value 3 selects class 3 (criterion 5)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(/^Seeded \d+ pixels in \d+ classes\.$/);
  expect(maskValue(48, 200)).toBe(3);
  await jumpTo(page, at(48.5, 200.5), 9);
  await altClick(page, await toScreen(page, at(48.5, 200.5)));
  await expect(message(page)).toHaveText(/^Picked .+\.$/);
  expect(await selected(page)).toBe(2);
  expect(await tileKeysStored(page)).toEqual([]); // still mask-only: nothing stored
});
