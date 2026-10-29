import { expect, test } from "@playwright/test";
import { BACKGROUND, FEATURE, hideBasemap, jumpTo, openApp, openRaster, pixelAt, rgbFixture, toScreen } from "./helpers";

const bg = [1, 3, 5].map((i) => parseInt(BACKGROUND.slice(i, i + 2), 16));
const notBackground = (px: number[]) => px.slice(0, 3).some((v, i) => Math.abs(v - bg[i]!) > 3);

test.describe("globe (criterion 12)", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await hideBasemap(page);
    await openRaster(page, rgbFixture());
    await expect(page.locator("#message")).toHaveText("Raster opened.");
  });

  test("projection is globe", async ({ page }) => {
    expect(await page.evaluate(() => (window as any).__geoapp.map.getProjection().type)).toBe("globe");
  });

  test("preview renders at zoom 3 and at a known feature at zoom 14", async ({ page }) => {
    await jumpTo(page, [15, 45], 3);
    expect(notBackground(await pixelAt(page, await toScreen(page, [15, 45])))).toBe(true);
    await jumpTo(page, FEATURE, 14);
    expect(notBackground(await pixelAt(page, await toScreen(page, FEATURE)))).toBe(true);
  });
  // Spec 001 criterion 12's polygon-vertex check is superseded by spec 003 criterion 9 (brush-hover.spec.ts).
});
