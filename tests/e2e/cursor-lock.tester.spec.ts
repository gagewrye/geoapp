import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { jumpTo, message, openApp, openRaster, rgbFixture, type Xy } from "./helpers";
import { seeded } from "./lockCombos";
import { importFile, openFileGate, pauseLabelFile, upload } from "./seeding";

// Tester edges of spec 010 criterion 8: selecting during a lock, and Space held when the lock ends.
const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const colourOf = (page: Page, i: number) => page.locator("#classes li .class-colour").nth(i).inputValue();

async function lockedImport(page: Page): Promise<Xy> {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 9);
  const box = (await page.locator("#map canvas").boundingBox())!;
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(p.x, p.y);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return p;
}

test("selecting class 2 by key during a lock keeps not-allowed; when the lock ends the brush shows class 2's colour", async ({ page }) => {
  const p = await lockedImport(page);
  await page.keyboard.press("2");
  await expect(page.locator("#classes li").nth(1)).toHaveClass(/selected/);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  const cur = await cursorAt(page, p);
  expect(cur.startsWith('url("data:image/svg+xml')).toBe(true);
  expect(decodeURIComponent(cur).toLowerCase()).toContain((await colourOf(page, 1)).toLowerCase());
});

test("with Space held when the lock ends, neither not-allowed nor the brush shows; releasing Space brings the brush", async ({ page }) => {
  const p = await lockedImport(page);
  await page.keyboard.down("Space");
  const during = await cursorAt(page, p);
  expect(during).not.toBe("not-allowed");
  expect(during.startsWith("url(")).toBe(false);
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  const held = await cursorAt(page, p);
  expect(held).not.toBe("not-allowed");
  expect(held.startsWith("url(")).toBe(false);
  await page.keyboard.up("Space");
  expect((await cursorAt(page, p)).startsWith('url("data:image/svg+xml')).toBe(true);
});
