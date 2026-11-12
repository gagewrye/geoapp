import { expect, test, type Page } from "@playwright/test";
import { brushCursor, eraserCursor } from "../../src/map/cursor";
import { jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, selectClass, stroke, toScreen, type Xy } from "./helpers";
import { importFile, openFileGate, pauseLabelFile, upload } from "./seeding";
import { classFile } from "../unit/helpers/labelFiles";

// Spec 058 criteria 5, 7 and 8. Criterion 4 is in tool-keys.spec.ts, criterion 6 in label-mask.spec.ts; spec 003 criterion 11's
// pen barrel drag is in brush-stroke.spec.ts, unchanged.
const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const selectedColour = (page: Page) => page.locator("#classes li.selected .class-colour").inputValue();
const lineProp = (page: Page, prop: string) => page.evaluate((p) => (window as any).__geoapp.map.getPaintProperty("brush-hover-line", p), prop);
/** Keys are shortcuts only outside text fields. */
const unfocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function setup(page: Page): Promise<Xy> {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 10);
  await paintMode(page);
  return toScreen(page, [15.005, 45.005]);
}

test("in Paint mode a right drag over classes 1 and 2, with class 1 selected, zeroes only the 1s (criterion 5)", async ({ page }) => {
  const c = await setup(page);
  await selectClass(page, 1);
  await stroke(page, [{ x: c.x + 120, y: c.y }, { x: c.x + 180, y: c.y }]);
  await selectClass(page, 0);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  const before = await labels(page);
  expect(new Set(before.values())).toEqual(new Set([1, 2]));
  await stroke(page, [c, { x: c.x + 60, y: c.y }, { x: c.x + 180, y: c.y }], "right");
  expect(await labels(page)).toEqual(new Map([...before].filter(([, v]) => v === 2)));
});

test("Erase shows the eraser cursor for any class; Paint the brush; Space, Pan and a lock show neither (criterion 7)", async ({ page }) => {
  const p = await setup(page);
  await page.click("#mode-erase");
  await page.mouse.move(p.x, p.y);
  expect(await cursorAt(page, p)).toBe(eraserCursor());
  await selectClass(page, 1);
  await page.mouse.move(p.x + 3, p.y);
  expect(await cursorAt(page, p)).toBe(eraserCursor());

  await page.click("#mode-paint");
  await page.mouse.move(p.x, p.y);
  expect(await cursorAt(page, p)).toBe(brushCursor(await selectedColour(page)));

  await page.click("#mode-erase");
  await unfocus(page);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down("Space");
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false);
  await page.keyboard.up("Space");
  expect(await cursorAt(page, p)).toBe(eraserCursor());

  await page.click("#mode-pan");
  await page.mouse.move(p.x, p.y);
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false);

  // locked during an import (spec 010 criterion 8)
  await page.click("#mode-erase");
  await page.mouse.move(p.x, p.y);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await page.mouse.move(p.x + 3, p.y);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await openFileGate(page);
});

test("the footprint is dashed white in Erase mode and solid in the class colour in Paint mode (criterion 8)", async ({ page }) => {
  const p = await setup(page);
  await page.mouse.move(p.x, p.y);
  await expect.poll(() => lineProp(page, "line-color")).toBe(await selectedColour(page));
  expect(await lineProp(page, "line-dasharray")).toBeUndefined();

  await page.click("#mode-erase");
  await page.mouse.move(p.x + 3, p.y);
  await expect.poll(() => lineProp(page, "line-color")).toBe("#ffffff");
  expect(await lineProp(page, "line-dasharray")).toBeDefined();

  await page.click("#mode-paint");
  await page.mouse.move(p.x, p.y);
  await expect.poll(() => lineProp(page, "line-color")).toBe(await selectedColour(page));
  expect(await lineProp(page, "line-dasharray")).toBeUndefined();
});
