import { expect, test, type Page } from "@playwright/test";
import { message, openApp, openRaster, rgbFixture, tiff } from "./helpers";
import { fileGate, fileWaiting as waiting, holdFile as hold, releaseFiles } from "./raceCombos";

// Async actions tied to the raster they started on (spec 003, tester F10): an open that another open
// overtakes.

/** 800 x 600, 3 bands, at 30..38E, 40..46N: a different size and place from rgbFixture. */
const otherFixture = () => tiff("other.tif", 800, 600, 3, (b, c) => (b === 0 ? (c < 400 ? 200 : 120) : 150),
  { epsg: 4326, gt: [30, 0.01, 0, 46, 0, -0.01] });
const info = (page: Page) => page.locator("#raster-info");
const imageryWidth = (page: Page) => page.evaluate(() => (window as any).__geoapp.imagery()?.meta.width as number | undefined);
const previewWest = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getSource("preview")?.coordinates[0][0] as number | undefined);

test.describe("an open that another open overtakes", () => {
  test("an older open still building its preview doesn't show it over the raster opened after it", async ({ page }) => {
    await fileGate(page);
    await openApp(page);
    await hold(page, "slow.tif", "committed");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
    await expect.poll(() => waiting(page)).toBeGreaterThan(0); // its preview reads wait
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    expect(await previewWest(page)).toBeCloseTo(30, 6);
    const center = await page.evaluate(() => (window as any).__geoapp.map.getCenter().lng as number);
    await releaseFiles(page);
    await page.waitForTimeout(800);
    expect(await previewWest(page)).toBeCloseTo(30, 6);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getCenter().lng as number)).toBeCloseTo(center, 6);
    expect(await imageryWidth(page)).toBe(800);
  });

  test("a newer open that is refused leaves the older open to finish", async ({ page }) => {
    await fileGate(page);
    await openApp(page);
    await hold(page, "slow.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect.poll(() => waiting(page)).toBeGreaterThan(0);
    await openRaster(page, tiff("swiss.tif", 4, 4, 1, () => 1, { epsg: 2056, gt: [2600000, 10, 0, 1200000, 0, -10] }));
    await expect(message(page)).toHaveText(/Unsupported CRS EPSG:2056/);
    await releaseFiles(page);
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
  });
});
