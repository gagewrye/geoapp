import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, rgbFixture, stroke, toScreen } from "./helpers";

// Spec 009 criterion 6 and the WASD rule's select clause, on #seed-mode: spec 013 shelved #aef-year, the
// select these cases used, and names #seed-mode (enabled once labels exist) as the kept control of that kind.
const centre = (page: Page) => page.evaluate(() => { const c = (window as any).__geoapp.map.getCenter(); return [c.lng, c.lat] as [number, number]; });

async function withLabels(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 9);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  await expect(page.locator("#seed-mode")).toBeEnabled();
}

test("with focus on the Seed mode select, holding W doesn't pan and the option is unchanged", async ({ page }) => {
  await withLabels(page);
  await page.focus("#seed-mode");
  const c0 = await centre(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(300);
  await page.keyboard.up("KeyW");
  expect(await centre(page)).toEqual(c0);
  await expect(page.locator("#seed-mode")).toHaveValue("merge");
});

test("focus entering the Seed mode select during a W hold stops the panning while the key stays down", async ({ page }) => {
  await withLabels(page);
  await page.locator("#map canvas").focus();
  const c0 = await centre(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(150);
  await page.focus("#seed-mode");
  await page.waitForTimeout(50);
  const c = await centre(page);
  await page.waitForTimeout(300);
  expect(await centre(page)).toEqual(c);
  expect(c).not.toEqual(c0);
  await page.keyboard.up("KeyW");
});
