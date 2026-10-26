import { expect, test, type Page } from "@playwright/test";
import { MAX_LAT } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import { FEATURE, clickAt, drawPolygon, jumpTo, message, openApp, openRaster, pixelAt, rgbFixture, setMode, snapshot, toScreen, type LngLat } from "./helpers";

// Tester additions: criteria 12 and 15 as written, beyond the implementer's tests.

const polygons = async (page: Page) => (await snapshot(page)).map((f) => f.geometry);

/** Drag with many small moves, as a real pointer does. */
async function smoothDrag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }, steps = 200, held: () => Promise<void> = async () => {}) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await held();
  await page.mouse.up();
  await page.waitForTimeout(100);
}

test("globe (criterion 12): at zoom 14 the known feature itself is drawn at its location", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, FEATURE, 14);
  const px = await pixelAt(page, await toScreen(page, FEATURE));
  expect(px.slice(0, 3).every((v) => v > 240), `feature pixel ${px}`).toBe(true); // white block
  await jumpTo(page, [FEATURE[0] + 0.2, FEATURE[1]], 14);
  const off = await pixelAt(page, await toScreen(page, [FEATURE[0] + 0.2, FEATURE[1]]));
  expect(off.slice(0, 3).every((v) => v > 240), `off-feature pixel ${off}`).toBe(false);
});

for (const sign of [1, -1]) {
  const hemi = sign > 0 ? "north" : "south";
  test.describe(`latitude limit, ${hemi} (criterion 15, tester)`, () => {
    const corners: LngLat[] = [[-10, sign * 76], [10, sign * 76], [10, sign * 82], [-10, sign * 82]];
    const polar = (ring: LngLat[]) => ring.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));

    test.beforeEach(async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [0, sign * 80], 1.5);
    });

    test("adding a vertex in draw mode beyond MAX_LAT leaves the stored polygon unchanged", async ({ page }) => {
      await setMode(page, "draw");
      await clickAt(page, await toScreen(page, [-10, sign * 78]));
      await clickAt(page, await toScreen(page, [10, sign * 78]));
      const before = await polygons(page);
      await clickAt(page, await toScreen(page, [0, sign * 88]));
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      expect(await polygons(page)).toEqual(before);
    });

    test("adding a vertex in edit mode (midpoint drag) beyond MAX_LAT is blocked and leaves the stored polygon unchanged", async ({ page }) => {
      // Wide polygon so the polar midpoint is far from any corner on screen; on small polygons
      // terra-draw grabs the nearby corner instead of the midpoint.
      const wide: LngLat[] = [[-30, sign * 76], [30, sign * 76], [30, sign * 82], [-30, sign * 82]];
      await drawPolygon(page, await Promise.all(wide.map((p) => toScreen(page, p))), "ice");
      await setMode(page, "select");
      await clickAt(page, await toScreen(page, [0, sign * 79]));
      const before = (await polygons(page))[0].coordinates[0] as LngLat[];
      const mid = (await page.evaluate(() => (window as any).__geoapp.draw.getSnapshot()))
        .filter((f: any) => f.properties.midPoint).map((f: any) => f.geometry.coordinates as LngLat);
      const m = polar(mid);
      const a = await toScreen(page, m);
      for (const v of before) expect(Math.hypot((await toScreen(page, v)).x - a.x, (await toScreen(page, v)).y - a.y)).toBeGreaterThan(60);
      let during: LngLat[] = [];
      await smoothDrag(page, a, await toScreen(page, [m[0], sign * 88]), 10, async () => { during = (await polygons(page))[0].coordinates[0]; });
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      expect(during).toHaveLength(before.length + 1); // the vertex really was added (midpoint, not a corner)
      for (const [, lat] of during) expect(Math.abs(lat)).toBeLessThan(MAX_LAT);
      // Criterion 15: the blocked edit, including its inserted vertex, leaves the stored polygon unchanged
      const after = (await polygons(page))[0].coordinates[0] as LngLat[];
      expect(after).toEqual(before);
    });

    test("an ordinary (smooth) vertex drag beyond MAX_LAT leaves the stored polygon unchanged", async ({ page }) => {
      await drawPolygon(page, await Promise.all(corners.map((p) => toScreen(page, p))), "ice");
      await setMode(page, "select");
      await clickAt(page, await toScreen(page, [0, sign * 79]));
      const before = await polygons(page);
      const v = polar(before[0].coordinates[0]);
      await smoothDrag(page, await toScreen(page, v), await toScreen(page, [v[0], sign * 88]));
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      const after = await polygons(page);
      // Spec 001 criterion 15: "the stored polygon is unchanged. No vertex is clamped."
      expect(after, `vertex ended at ${JSON.stringify(polar(after[0].coordinates[0]))}`).toEqual(before);
    });
  });
}
