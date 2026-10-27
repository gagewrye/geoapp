import { expect, test, type Page } from "@playwright/test";
import { footprint, footprintRing, pixelAt } from "../../src/core/pixel";
import { RGB_GRID, hoverFeatures, jumpTo, labels, message, moveTo, openApp, openRaster, rgbFixture, stroke, toLngLat, toScreen } from "./helpers";

// Spec 003 criterion 9 (hover), and criterion 8's "hovering and erasing read no window".

async function setup(page: Page, zoom = 9) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], zoom);
}

/** Count imagery window reads from now on (the hook's source is the one the brush reads). */
const countReads = (page: Page) => page.evaluate(() => {
  const s = (window as any).__geoapp.imagery();
  const read = s.readWindow.bind(s);
  (window as any).__reads = 0;
  s.readWindow = (...a: unknown[]) => { (window as any).__reads++; return read(...a); };
});
const reads = (page: Page) => page.evaluate(() => (window as any).__reads as number);

test.describe("hover (criterion 9)", () => {
  for (const zoom of [3, 9, 14]) {
    test(`zoom ${zoom}: a mouse moved with no button shows one feature, footprintRing at pixelAt of the pointer, in the selected colour`, async ({ page }) => {
      await setup(page, zoom);
      const c = await toScreen(page, zoom === 14 ? [15.0012, 44.9987] : [15.0123, 44.9871]);
      await moveTo(page, { x: c.x - 30, y: c.y - 20 }, c, 5);
      const [ll] = await toLngLat(page, [c]);
      const [col, row] = pixelAt(RGB_GRID, ...ll!);
      const want = footprintRing(RGB_GRID, footprint(RGB_GRID, col, row, 7)!);
      await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
      const [f] = await hoverFeatures(page);
      const ring: [number, number][] = f.geometry.coordinates[0];
      expect(ring).toHaveLength(5);
      ring.forEach(([lon, lat], i) => {
        expect(Math.abs(lon - want[i]![0])).toBeLessThan(1e-6);
        expect(Math.abs(lat - want[i]![1])).toBeLessThan(1e-6);
      });
      const colour = await page.evaluate(() => (window as any).__geoapp.labels.classes[0].colour);
      expect(await page.evaluate(() => (window as any).__geoapp.map.getPaintProperty("brush-hover-fill", "fill-color"))).toBe(colour);
      expect(await page.evaluate(() => (window as any).__geoapp.map.getPaintProperty("brush-hover-fill", "fill-opacity"))).toBe(0.4);
      expect((await labels(page)).size).toBe(0);
    });
  }

  test("over the panel, off the raster or off the globe there is none", async ({ page }) => {
    await setup(page, 5);
    const c = await toScreen(page, [15, 45]);
    await page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
    const panel = (await page.locator("#panel").boundingBox())!;
    await page.mouse.move(panel.x + panel.width / 2, c.y);
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(0);
    const off = await toScreen(page, [25, 45]); // east of the raster
    await page.mouse.move(off.x, off.y);
    await page.mouse.move(off.x + 2, off.y);
    expect(await hoverFeatures(page)).toHaveLength(0);
    await page.mouse.move(c.x, c.y);
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
    await jumpTo(page, [15, 45], 1.5);
    const box = (await page.locator("#map canvas").boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5); // the sky beyond the globe
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(0);
    expect((await labels(page)).size).toBe(0);
  });
});

test("hovering and erasing read no imagery window (criterion 8)", async ({ page }) => {
  await setup(page, 9);
  const c = await toScreen(page, [15.005, 45.005]); // a pixel centre, so both strokes stay on its row
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  expect((await labels(page)).size).toBeGreaterThan(0);
  await countReads(page);
  await moveTo(page, { x: c.x - 100, y: c.y - 80 }, { x: c.x + 120, y: c.y + 90 }, 30);
  await stroke(page, [{ x: c.x - 20, y: c.y }, { x: c.x + 200, y: c.y }], "right");
  expect((await labels(page)).size).toBe(0);
  expect(await reads(page)).toBe(0);
});
