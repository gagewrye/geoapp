import { expect, test, type Page } from "@playwright/test";
import {
  clickAt, collectErrors, dragPanEnabled, drawPolygon, jumpTo, lonDiff, moveTo, openApp, rings, setMode, snapshot, toLngLat, toScreen, toucher,
} from "./helpers";

// Tester: pointer capture and pointercancel handling in src/map/draw.ts (criterion 15, F1/F2
// fixes) must not regress map gestures or criteria 2 and 12.

const allFeatures = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().length as number);
const view = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  const c = map.getCenter();
  return { lng: c.lng as number, lat: c.lat as number, zoom: map.getZoom() as number };
});
const idle = (page: Page) => page.waitForFunction(() => !(window as any).__geoapp.map.isMoving(), undefined, { timeout: 5000 });

test.describe("map gestures still work with pointer capture (tester)", () => {
  for (const mode of ["draw", "select"] as const) {
    test(`${mode} mode: a mouse pan moves the map, a pan released over the panel ends there, and nothing is drawn`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const c = await toScreen(page, [0, 0]);
      const v0 = await view(page);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await moveTo(page, c, { x: c.x + 150, y: c.y + 40 });
      const v1 = await view(page);
      expect(Math.abs(v1.lng - v0.lng), "map panned").toBeGreaterThan(1);
      const panel = (await page.locator("#panel").boundingBox())!;
      await moveTo(page, { x: c.x + 150, y: c.y + 40 }, { x: panel.x + panel.width / 2, y: c.y });
      await page.mouse.up();
      await idle(page); // pan inertia
      const v2 = await view(page);
      // button up: hovering back over the map must not pan
      await moveTo(page, { x: panel.x + panel.width / 2, y: c.y }, { x: c.x + 200, y: c.y + 100 });
      await page.waitForTimeout(300);
      const v3 = await view(page);
      expect(Math.abs(v3.lng - v2.lng) + Math.abs(v3.lat - v2.lat), "no pan with the button up").toBeLessThan(1e-6);
      expect(await allFeatures(page), "nothing drawn").toBe(0);
      expect(await dragPanEnabled(page)).toBe(true);
      expect(errors).toEqual([]);
    });

    test(`${mode} mode: wheel zoom still zooms`, async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const c = await toScreen(page, [0, 0]);
      await page.mouse.move(c.x, c.y);
      const z0 = (await view(page)).zoom;
      for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
      await page.waitForTimeout(800);
      expect((await view(page)).zoom).toBeGreaterThan(z0 + 0.3);
      expect(await allFeatures(page)).toBe(0);
    });

    test(`${mode} mode: a one-finger touch pan moves the map and draws nothing`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const touch = toucher(await page.context().newCDPSession(page));
      const c = await toScreen(page, [0, 0]);
      const v0 = await view(page);
      await touch("touchStart", [[0, c]]);
      for (let i = 1; i <= 20; i++) await touch("touchMove", [[0, { x: c.x + 8 * i, y: c.y }]]);
      await touch("touchEnd");
      await page.waitForTimeout(500);
      expect(Math.abs((await view(page)).lng - v0.lng), "map panned").toBeGreaterThan(1);
      expect(await allFeatures(page), "nothing drawn").toBe(0);
      expect(errors).toEqual([]);
    });

    test(`${mode} mode: a two-finger pinch zooms the map and draws nothing`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      await setMode(page, mode);
      const touch = toucher(await page.context().newCDPSession(page));
      const c = await toScreen(page, [0, 0]);
      const z0 = (await view(page)).zoom;
      await touch("touchStart", [[0, { x: c.x - 20, y: c.y }]]);
      await touch("touchStart", [[0, { x: c.x - 20, y: c.y }], [1, { x: c.x + 20, y: c.y }]]);
      for (let i = 1; i <= 20; i++) await touch("touchMove", [[0, { x: c.x - 20 - 7 * i, y: c.y }], [1, { x: c.x + 20 + 7 * i, y: c.y }]]);
      await touch("touchEnd");
      await page.waitForTimeout(500);
      expect((await view(page)).zoom, "pinch zoomed in").toBeGreaterThan(z0 + 0.5);
      expect(await allFeatures(page), "nothing drawn").toBe(0);
      expect(errors).toEqual([]);
    });

    test(`${mode} mode: a touch pan ended by pointercancel draws nothing, edits nothing, and the next mouse polygon is exact`, async ({ page }) => {
      const errors = collectErrors(page);
      await openApp(page);
      await jumpTo(page, [0, 0], 3);
      // an existing, selected polygon (select mode) must survive the cancelled pan unchanged
      const c = await toScreen(page, [0, 0]);
      await drawPolygon(page, [{ x: c.x - 250, y: c.y - 200 }, { x: c.x - 150, y: c.y - 200 }, { x: c.x - 150, y: c.y - 100 }, { x: c.x - 250, y: c.y - 100 }], "a");
      await setMode(page, mode);
      if (mode === "select") await clickAt(page, { x: c.x - 200, y: c.y - 150 });
      const before = await rings(page);
      const touch = toucher(await page.context().newCDPSession(page));
      await touch("touchStart", [[0, c]]);
      for (let i = 1; i <= 15; i++) await touch("touchMove", [[0, { x: c.x + 6 * i, y: c.y + 2 * i }]]);
      await touch("touchCancel");
      await page.waitForTimeout(300);
      expect(await rings(page), "existing polygon unchanged").toEqual(before);
      expect((await snapshot(page)).length, "no new polygon").toBe(1);
      expect(await dragPanEnabled(page), "map panning re-enabled").toBe(true);
      // criteria 2 and 12 still hold: draw by clicking four points, vertices = unproject of the clicks
      await jumpTo(page, [10, 5], 3);
      const d = await toScreen(page, [10, 5]);
      const pts = [{ x: d.x + 20, y: d.y - 60 }, { x: d.x + 160, y: d.y - 60 }, { x: d.x + 160, y: d.y + 60 }, { x: d.x + 20, y: d.y + 60 }];
      const expected = await toLngLat(page, pts);
      await drawPolygon(page, pts, "b");
      const all = await rings(page);
      expect(all).toHaveLength(2);
      const drawn = all.find((r) => r[0]![0] > 5)!;
      expect(drawn).toHaveLength(5);
      for (const [elon, elat] of expected) {
        const hit = drawn.slice(0, 4).some(([lon, lat]) => Math.abs(lonDiff(lon, elon)) < 1e-6 && Math.abs(lat - elat) < 1e-6);
        expect(hit, `vertex at unproject ${elon},${elat} in ${JSON.stringify(drawn)}`).toBe(true);
      }
      expect(errors).toEqual([]);
    });
  }
});
