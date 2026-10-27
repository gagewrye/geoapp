import { expect, test, type Page } from "@playwright/test";
import { jumpTo, labels, message, moveTo, openApp, openRaster, rgbFixture, settled, stroke, toScreen, view } from "./helpers";

// Tester: spec 003 criterion 12 after a paint stroke. terra-draw's MapLibre adapter calls
// setDraggability(true) on pointerup; the brush then re-applies Paint mode's handler state, so
// map.dragRotate stays off. These check that nothing the user sees changes: right drags still
// erase, double-click and Shift-drag still don't zoom.

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 7);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  expect((await labels(page)).size).toBeGreaterThan(0);
  return c;
}
const idle = (page: Page) => page.waitForFunction(() => !(window as any).__geoapp.map.isMoving(), undefined, { timeout: 5000 });

test.describe("MapLibre handlers stay off in Paint mode after a stroke (criterion 12, tester)", () => {
  test("a right drag after a paint stroke erases and doesn't rotate", async ({ page }) => {
    const c = await setup(page);
    const v0 = await view(page);
    await page.mouse.move(c.x - 20, c.y);
    await page.mouse.down({ button: "right" });
    await moveTo(page, { x: c.x - 20, y: c.y }, { x: c.x + 100, y: c.y }, 20);
    await page.mouse.up({ button: "right" });
    await settled(page);
    await idle(page);
    expect((await labels(page)).size).toBe(0);
    expect(await view(page)).toEqual(v0);
  });

  test("a double-click and a Shift-drag after a paint stroke don't zoom", async ({ page }) => {
    const c = await setup(page);
    const v0 = await view(page);
    await page.mouse.dblclick(c.x, c.y + 80);
    await page.waitForTimeout(500);
    await settled(page);
    await idle(page);
    expect((await view(page)).zoom).toBe(v0.zoom);
    await page.keyboard.down("Shift");
    await stroke(page, [{ x: c.x, y: c.y + 120 }, { x: c.x + 80, y: c.y + 180 }]);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(500);
    await idle(page);
    expect((await view(page)).zoom).toBe(v0.zoom);
    expect(await page.evaluate(() => {
      const { map } = (window as any).__geoapp;
      return [map.doubleClickZoom.isEnabled(), map.boxZoom.isEnabled()];
    })).toEqual([false, false]);
  });

  test("record: dragRotate's enabled state in Paint mode before and after a stroke", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const rot = () => page.evaluate(() => (window as any).__geoapp.map.dragRotate.isEnabled() as boolean);
    const before = await rot();
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 20, y: c.y }]);
    test.info().annotations.push({ type: "dragRotate enabled in Paint mode", description: `before a stroke ${before}, after ${await rot()}` });
    expect(before).toBe(false);
  });
});

// Tester pass 3: terra-draw also calls setDoubleClickToZoom(true) when a mode stops, which the F11
// restore hook doesn't cover. Choosing Paint after the area tool stops rectangle mode after the
// brush synced its handlers, so doubleClickZoom is on in Paint mode until the next canvas pointerup.
test.describe("handlers after the area tool, then Paint (criterion 12, tester pass 3)", () => {
  async function aoiThenPaint(page: Page) {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    await page.click("#aef-draw");
    await page.click("#mode-paint");
  }
  const handlers = (page: Page) => page.evaluate(() => {
    const { map } = (window as any).__geoapp;
    return [map.doubleClickZoom.isEnabled(), map.dragRotate.isEnabled(), map.boxZoom.isEnabled()];
  });

  test("a double-click doesn't zoom", async ({ page }) => {
    await aoiThenPaint(page);
    const c = await toScreen(page, [15.005, 45.005]);
    const v0 = await view(page);
    await page.mouse.dblclick(c.x, c.y);
    await page.waitForTimeout(500);
    await settled(page);
    await idle(page);
    expect((await view(page)).zoom).toBe(v0.zoom);
    expect(await handlers(page)).toEqual([false, false, false]);
  });

  test("F12: Paint mode's handlers are off as soon as Paint is chosen", async ({ page }) => {
    await aoiThenPaint(page);
    expect(await handlers(page)).toEqual([false, false, false]);
  });
});

// Review of spec 003: outside Paint mode the brush leaves terra-draw in charge, so rectangle mode keeps
// double-click zoom off (as on spec 002), with or without imagery open.
test.describe("double-click zoom stays off while the area tool is active (spec 002)", () => {
  for (const imagery of [false, true]) {
    test(`after Draw area and after a click in rectangle mode${imagery ? ", with imagery open" : ""}`, async ({ page }) => {
      await openApp(page);
      if (imagery) {
        await openRaster(page, rgbFixture());
        await expect(message(page)).toHaveText("Raster opened.");
      }
      await jumpTo(page, [15, 45], 7);
      const dblZoom = () => page.evaluate(() => (window as any).__geoapp.map.doubleClickZoom.isEnabled() as boolean);
      await page.click("#aef-draw");
      expect(await dblZoom()).toBe(false);
      const c = await toScreen(page, [15.005, 45.005]);
      await page.mouse.click(c.x, c.y);
      expect(await dblZoom()).toBe(false);
    });
  }
});
