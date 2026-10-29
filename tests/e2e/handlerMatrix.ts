import { expect, type Page } from "@playwright/test";
import { jumpTo, labels, message, moveTo, openRaster, rgbFixture, tiff, toScreen } from "./helpers";

// Helpers for brush-handler-matrix.tester.spec.ts: MapLibre handler flags and the gestures they gate.

/** dragRotate, doubleClickZoom, boxZoom, dragPan enabled, as "1"/"0". */
export const flags = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  return [map.dragRotate, map.doubleClickZoom, map.boxZoom, map.dragPan].map((h) => (h.isEnabled() ? "1" : "0")).join("");
});

export const CENTRE: [number, number] = [15, 45];
const reset = async (page: Page) => {
  await page.evaluate(() => (window as any).__geoapp.map.jumpTo({ bearing: 0, pitch: 0 }));
  await jumpTo(page, CENTRE, 7);
};
const still = (page: Page) => page.waitForFunction(() => !(window as any).__geoapp.map.isMoving(), undefined, { timeout: 5000 });
const zoom = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getZoom() as number);
const bearing = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getBearing() as number);

export type Gestures = { dblclick: boolean; boxZoom: boolean; rotate: boolean };

/** Whether a double-click zoomed, a Shift-drag zoomed and a right drag rotated, each from the same view. */
export async function gestures(page: Page): Promise<Gestures> {
  const c = await toScreen(page, [15.005, 45.005]);
  await reset(page);
  let z0 = await zoom(page);
  await page.mouse.dblclick(c.x, c.y);
  await page.waitForTimeout(400);
  await still(page);
  const dblclick = Math.abs((await zoom(page)) - z0) > 1e-6;
  await reset(page);
  z0 = await zoom(page);
  await page.keyboard.down("Shift");
  await page.mouse.move(c.x - 80, c.y - 80);
  await page.mouse.down();
  await moveTo(page, { x: c.x - 80, y: c.y - 80 }, { x: c.x + 80, y: c.y + 80 }, 12);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(400);
  await still(page);
  const boxZoom = Math.abs((await zoom(page)) - z0) > 1e-6;
  await reset(page);
  await page.mouse.move(c.x - 60, c.y + 40);
  await page.mouse.down({ button: "right" });
  await moveTo(page, { x: c.x - 60, y: c.y + 40 }, { x: c.x + 140, y: c.y + 40 }, 20);
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(200);
  await still(page);
  const rotate = Math.abs(await bearing(page)) > 1e-6;
  await reset(page);
  return { dblclick, boxZoom, rotate };
}

export const PAINT = "0001", PAN = "1111";
export const NONE: Gestures = { dblclick: false, boxZoom: false, rotate: false };
export const ALL: Gestures = { dblclick: true, boxZoom: true, rotate: true };

export async function openRgb(page: Page): Promise<void> {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, CENTRE, 7);
}
/** A second raster over the same place, so the view stays on imagery. */
export async function openOther(page: Page): Promise<void> {
  await openRaster(page, tiff("other.tif", 1000, 1000, 3, (b, c) => (b === 0 ? (c < 500 ? 90 : 160) : 140),
    { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }));
  await expect(page.locator("#raster-info")).toContainText("other.tif");
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, CENTRE, 7);
}
export const blurFocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
export const anyLabels = async (page: Page) => (await labels(page)).size > 0;
