import { expect, test } from "@playwright/test";
import { FEATURE, drawPolygon, jumpTo, openApp, openRaster, pixelAt, rgbFixture, snapshot, toLngLat, toScreen, lonDiff, type LngLat } from "./helpers";

const BACKGROUND = [0x1d, 0x2b, 0x3a];
const notBackground = (px: number[]) => px.slice(0, 3).some((v, i) => Math.abs(v - BACKGROUND[i]!) > 3);

test.describe("globe (criterion 12)", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
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

  for (const zoom of [3, 14]) {
    test(`clicked vertices equal map.unproject at zoom ${zoom}`, async ({ page }) => {
      await jumpTo(page, [15, 45], zoom);
      const c = await toScreen(page, [15, 45]);
      const pts = [{ x: c.x - 60, y: c.y - 40 }, { x: c.x + 50, y: c.y - 45 }, { x: c.x + 55, y: c.y + 40 }, { x: c.x - 45, y: c.y + 50 }];
      const expected = await toLngLat(page, pts);
      await drawPolygon(page, pts, "a");
      const polys = await snapshot(page);
      expect(polys).toHaveLength(1);
      const ring: LngLat[] = polys[0].geometry.coordinates[0];
      expect(ring).toHaveLength(5);
      // terra-draw may rewind the ring (right-hand rule), so match vertices regardless of order
      for (const [elon, elat] of expected) {
        const hit = ring.slice(0, 4).some(([lon, lat]) => Math.abs(lonDiff(lon, elon)) < 1e-6 && Math.abs(lat - elat) < 1e-6);
        expect(hit, `vertex ${elon},${elat} in ${JSON.stringify(ring)}`).toBe(true);
      }
    });
  }
});
