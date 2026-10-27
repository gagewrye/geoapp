import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { chip, chipCentre, drawArea, drawSmallArea, lonLatBox } from "./aef";
import { jumpTo, labels, message, openApp, openRaster, paintTwoClasses, rgbFixture, toScreen, type LngLat } from "./helpers";

// Spec 002 criterion 3 in the UI, and the area rectangle kept apart from spec 003's brush labels.

const areas = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().filter((f: any) => f.properties.mode === "rectangle").length);

test.describe("refused areas (criterion 3)", () => {
  const cases = [
    { name: "spanning lon 5.9-6.1 (two zones)", centre: [6, 45] as LngLat, zoom: 9, box: [5.9, 44.95, 6.1, 45.05], text: MESSAGES.zones },
    { name: "spanning the equator", centre: [3, 0] as LngLat, zoom: 9, box: [2.95, -0.1, 3.05, 0.1], text: MESSAGES.zones },
    { name: "over 20 km on a side", centre: [-81, 24.5] as LngLat, zoom: 9, box: [-81.15, 24.45, -80.85, 24.55], text: MESSAGES.size },
  ];
  for (const c of cases) {
    test(`an area ${c.name} shows "${c.text}" and can't be fetched`, async ({ page }) => {
      await openApp(page);
      await jumpTo(page, c.centre, c.zoom);
      await drawArea(page, c.box);
      await expect(message(page)).toHaveText(c.text);
      await expect(page.locator("#aef-fetch")).toBeDisabled();
      expect(await areas(page), "the refused outline is removed").toBe(0);
    });
  }

  test("a 2048 px area is accepted and shows its size", async ({ page }) => {
    await openApp(page);
    await jumpTo(page, chipCentre, 11);
    // 20.4 km square in UTM around the chip, so the snapped grid stays within 2048 px per side
    const [x0, y0] = [chip.x0 + 640 - 10200, chip.y1 - 640 - 10200];
    await drawArea(page, lonLatBox(chip.epsg, [x0 + 10, y0 + 10, x0 + 20390, y0 + 20390], 0));
    await expect(page.locator("#aef-info")).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
    const [w, h] = (await page.locator("#aef-info").textContent())!.match(/\d+/g)!.map(Number);
    expect(Math.max(w!, h!)).toBeLessThanOrEqual(2048);
    await expect(message(page)).toHaveText("");
  });
});

test("the area is one rectangle, never a label", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await drawSmallArea(page, [13, 45.5]);
  await drawSmallArea(page, [15, 45.5]); // replaces the first
  expect(await areas(page)).toBe(1);
  await page.click("#mode-paint"); // the area tool switched the brush to Pan (ADR 0009)
  await paintTwoClasses(page);
  expect((await labels(page)).size).toBeGreaterThan(0);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
  // painting over the area's edge labels pixels and leaves the area alone
  await jumpTo(page, [15, 45.5], 12);
  const edge = await toScreen(page, [15, 45.51] as LngLat);
  await page.mouse.click(edge.x, edge.y);
  const snap = await page.evaluate(() => (window as any).__geoapp.draw.getSnapshot());
  expect(snap.map((f: any) => f.properties.mode)).toEqual(["rectangle"]);
  expect(snap.some((f: any) => f.properties.selected)).toBe(false);
});
