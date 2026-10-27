import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { chip, chipBox, chipCentre, drawArea, drawSmallArea, lonLatBox, serveAef } from "./aef";
import { clickAt, collectErrors, drawPolygon, jumpTo, message, moveTo, openApp, openRaster, rgbFixture, toScreen, type LngLat } from "./helpers";

// Tester e2e for spec 002's area tool (criterion 3, Scope).
const areas = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().filter((f: any) => f.properties.mode === "rectangle").length);
const rectIds = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().filter((f: any) => f.properties.mode === "rectangle").map((f: any) => f.id));
const rect = (page: Page, [w, s, e, n]: number[]) => Promise.all(([[w, n], [e, n], [e, s], [w, s]] as LngLat[]).map((p) => toScreen(page, p)));
const box = lonLatBox(chip.epsg, chipBox, 30);

test.describe("area tool (criterion 3, Scope)", () => {
  // Tester F3: a refused area is removed, so the outline on the map is always the area; the earlier one stays.
  test("a refused area after an accepted one is removed and keeps the earlier area, its info and Fetch; an accepted one clears the message", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 9); // the globe at zoom 9 keeps a 30 km box on screen
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 300));
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    await expect(page.locator("#aef-info")).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
    const info = await page.locator("#aef-info").textContent();
    const first = await rectIds(page);
    // about 30 km across: too large
    const [x, y] = [chip.x0, chip.y1];
    await drawArea(page, lonLatBox(chip.epsg, [x - 15000, y - 15000, x + 15000, y + 15000], 0));
    await expect(message(page)).toHaveText(MESSAGES.size);
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    await expect(page.locator("#aef-info")).toHaveText(info!);
    expect(await rectIds(page), "the earlier area is the one drawn").toEqual(first);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 300));
    await expect(message(page)).toHaveText("");
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    expect(await areas(page)).toBe(1);
  });

  test("Escape mid-draw keeps the earlier area, and the next area draws normally", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 13);
    await drawArea(page, box);
    const info = await page.locator("#aef-info").textContent();
    await page.click("#aef-draw");
    const a = await toScreen(page, [box[0]!, box[3]!]);
    await clickAt(page, a);
    await moveTo(page, a, { x: a.x + 60, y: a.y + 60 }, 5);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    expect(await areas(page)).toBe(1);
    await expect(page.locator("#aef-info")).toHaveText(info!);
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 10));
    expect(await areas(page)).toBe(1);
  });

  test("switching to polygon mode mid-rectangle drops the rectangle; the polygon drawn next is a label, not the area", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await page.click("#aef-draw");
    const a = await toScreen(page, [12, 47]);
    await clickAt(page, a);
    await moveTo(page, a, { x: a.x + 50, y: a.y + 50 }, 5);
    await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "only");
    expect(await areas(page)).toBe(0);
    await expect(page.locator("#polygons li")).toHaveCount(1);
    await expect(page.locator("#aef-info")).toHaveText("");
    await expect(page.locator("#aef-fetch")).toBeDisabled();
  });

  test("Enter right after the first corner (a zero-size area) neither throws nor leaves Fetch and the area info disagreeing", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 13);
    await page.click("#aef-draw");
    await clickAt(page, await toScreen(page, chipCentre));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
    expect(await areas(page)).toBeLessThanOrEqual(1);
    const info = (await page.locator("#aef-info").textContent()) ?? "";
    if (info) await expect(page.locator("#aef-fetch")).toBeEnabled();
    else await expect(page.locator("#aef-fetch")).toBeDisabled();
  });

  test("one labelled class plus the area is still one class: training is refused (single-class labels)", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await drawSmallArea(page, [15, 45.5]); // refused areas are removed (F3), so an accepted one
    await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "only");
    await page.click("#train");
    await expect(message(page)).toHaveText("Draw polygons for at least two classes.");
  });

  test("Delete in select mode removes a selected polygon and never the area", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await drawSmallArea(page, [15, 45.5]); // refused areas are removed (F3), so an accepted one
    await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "a");
    await page.click("#mode-select");
    await clickAt(page, await toScreen(page, [12, 44.5]));
    await page.keyboard.press("Delete");
    await clickAt(page, await toScreen(page, [15, 45.5])); // inside the area
    await page.keyboard.press("Delete");
    await page.waitForTimeout(150);
    expect(await areas(page)).toBe(1);
  });
});
