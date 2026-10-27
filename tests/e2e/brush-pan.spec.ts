import { expect, test, type Page } from "@playwright/test";
import { hoverFeatures, jumpTo, labels, message, moveTo, openApp, openRaster, rgbFixture, settled, stroke, toScreen, toucher, view } from "./helpers";

// Spec 003 criterion 12: pan and zoom alongside the brush.

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 7);
  return toScreen(page, [15.005, 45.005]);
}
const idle = (page: Page) => page.waitForFunction(() => !(window as any).__geoapp.map.isMoving(), undefined, { timeout: 5000 });
const count = async (page: Page) => (await labels(page)).size;
const moved = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) => Math.abs(a.lng - b.lng) + Math.abs(a.lat - b.lat);

test.describe("pan and zoom (criterion 12)", () => {
  test("in Paint mode the wheel zooms and paints nothing", async ({ page }) => {
    const c = await setup(page);
    await page.mouse.move(c.x, c.y);
    const z0 = (await view(page)).zoom;
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
    await page.waitForTimeout(600);
    await idle(page);
    expect((await view(page)).zoom).toBeGreaterThan(z0 + 0.3);
    expect(await count(page)).toBe(0);
  });

  test("with Space held a left drag pans and paints nothing; once Space is released a left drag paints", async ({ page }) => {
    const c = await setup(page);
    const v0 = await view(page);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down("Space");
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(0); // Space acts as Pan: no footprint
    await page.mouse.down();
    await moveTo(page, c, { x: c.x + 150, y: c.y + 40 }, 15);
    await page.mouse.up();
    await page.keyboard.up("Space");
    await idle(page);
    const v1 = await view(page);
    expect(moved(v1, v0)).toBeGreaterThan(0.5);
    expect(await count(page)).toBe(0);
    const d = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [d, { x: d.x + 40, y: d.y }]);
    expect(await count(page)).toBeGreaterThan(0);
    expect(moved(await view(page), v1)).toBeLessThan(1e-9);
  });

  test("in Pan mode a left drag pans, a right drag rotates, and nothing is painted", async ({ page }) => {
    const c = await setup(page);
    await page.click("#mode-pan");
    await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
    const v0 = await view(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await moveTo(page, c, { x: c.x + 150, y: c.y + 40 }, 15);
    await page.mouse.up();
    await idle(page);
    const v1 = await view(page);
    expect(moved(v1, v0)).toBeGreaterThan(0.5);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: "right" });
    await moveTo(page, c, { x: c.x + 200, y: c.y }, 20);
    await page.mouse.up({ button: "right" });
    await idle(page);
    expect(Math.abs((await view(page)).bearing - v1.bearing)).toBeGreaterThan(5);
    expect(await count(page)).toBe(0);
    expect(await hoverFeatures(page)).toHaveLength(0);
  });

  test("a double-click in Paint mode leaves zoom unchanged", async ({ page }) => {
    const c = await setup(page);
    const z0 = (await view(page)).zoom;
    await page.mouse.dblclick(c.x, c.y);
    await page.waitForTimeout(500);
    await settled(page);
    expect((await view(page)).zoom).toBe(z0);
  });

  test("a one-finger touch drag (CDP) pans, paints nothing and shows no footprint", async ({ page }) => {
    const c = await setup(page);
    const v0 = await view(page);
    const touch = toucher(await page.context().newCDPSession(page));
    await touch("touchStart", [[1, c]]);
    for (let i = 1; i <= 15; i++) {
      await touch("touchMove", [[1, { x: c.x + 10 * i, y: c.y + 3 * i }]]);
      expect(await hoverFeatures(page)).toHaveLength(0);
    }
    await touch("touchEnd");
    await idle(page);
    expect(moved(await view(page), v0)).toBeGreaterThan(0.5);
    expect(await count(page)).toBe(0);
    expect(await hoverFeatures(page)).toHaveLength(0);
  });
});
