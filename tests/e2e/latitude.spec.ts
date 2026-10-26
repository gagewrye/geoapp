import { expect, test } from "@playwright/test";
import { MAX_LAT } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import { clickAt, drawPolygon, jumpDrag, jumpTo, message, openApp, setMode, snapshot, toLngLat, toScreen } from "./helpers";

for (const sign of [1, -1]) {
  const hemi = sign > 0 ? "north" : "south";
  test.describe(`latitude limit, ${hemi}, on the globe (criterion 15)`, () => {
    test.beforeEach(async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [0, sign * 80], 1.5);
      expect(await page.evaluate(() => (window as any).__geoapp.map.getProjection().type)).toBe("globe");
    });

    test("adding a vertex beyond MAX_LAT is blocked", async ({ page }) => {
      const beyond = await toScreen(page, [0, sign * 88]);
      const [ll] = await toLngLat(page, [beyond]);
      expect(beyond.y).toBeGreaterThan(0); // on the canvas, so the click really lands beyond the limit
      expect(Math.abs(ll![1])).toBeGreaterThan(MAX_LAT);
      await setMode(page, "draw");
      await clickAt(page, await toScreen(page, [-10, sign * 78]));
      await clickAt(page, await toScreen(page, [10, sign * 78]));
      await clickAt(page, beyond);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      for (const f of await snapshot(page)) for (const [, lat] of f.geometry.coordinates[0]) expect(Math.abs(lat)).toBeLessThan(MAX_LAT);
    });

    test("dragging a vertex beyond MAX_LAT is blocked and nothing is clamped", async ({ page }) => {
      const corners: [number, number][] = [[-10, sign * 76], [10, sign * 76], [10, sign * 82], [-10, sign * 82]];
      await drawPolygon(page, await Promise.all(corners.map((p) => toScreen(page, p))), "ice");
      const before = await snapshot(page);
      expect(before).toHaveLength(1);
      await setMode(page, "select");
      await clickAt(page, await toScreen(page, [0, sign * 79]));
      const ring: [number, number][] = before[0].geometry.coordinates[0];
      const v = ring.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
      const target = await toScreen(page, [v[0], sign * 88]);
      expect(target.y).toBeGreaterThan(0);
      // Jump straight past the limit so the only drag update is the blocked one.
      await jumpDrag(page, await toScreen(page, v), target);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      const after = await snapshot(page);
      expect(after.map((f) => f.geometry)).toEqual(before.map((f) => f.geometry));
      for (const [, lat] of after[0].geometry.coordinates[0]) expect(Math.abs(lat)).not.toBe(MAX_LAT);
    });
  });
}
