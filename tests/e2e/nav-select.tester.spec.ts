import { expect, test, type Page } from "@playwright/test";
import { addTestSelect, jumpTo, message, openApp, openRaster, paintMode, rgbFixture, stroke, toScreen } from "./helpers";

// Spec 009 criterion 6 and the WASD rule's select clause. The app has no select since spec 017, so these
// cases add one to #panel (spec 009 as amended by spec 017).
const centre = (page: Page) => page.evaluate(() => { const c = (window as any).__geoapp.map.getCenter(); return [c.lng, c.lat] as [number, number]; });

async function withLabels(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  await addTestSelect(page);
}

test("with focus on a select in the panel, holding W doesn't pan and the option is unchanged", async ({ page }) => {
  await withLabels(page);
  await page.focus("#test-select");
  const c0 = await centre(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(300);
  await page.keyboard.up("KeyW");
  expect(await centre(page)).toEqual(c0);
  await expect(page.locator("#test-select")).toHaveValue("a");
});

test("focus entering a select in the panel during a W hold stops the panning while the key stays down", async ({ page }) => {
  await withLabels(page);
  await page.locator("#map canvas").focus();
  const c0 = await centre(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(150);
  await page.focus("#test-select");
  await page.waitForTimeout(50);
  const c = await centre(page);
  await page.waitForTimeout(300);
  expect(await centre(page)).toEqual(c);
  expect(c).not.toEqual(c0);
  await page.keyboard.up("KeyW");
});
