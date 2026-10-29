import { expect, test, type Page } from "@playwright/test";
import { hoverFeatures, jumpTo, labels, message, moveTo, openApp, openRaster, rgbFixture, settled, stroke, toScreen, toucher, view } from "./helpers";

// Spec 003 criterion 12: pan and zoom alongside the brush.

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 7);
  await page.evaluate(() => {
    const g = (window as any).__space = [] as boolean[];
    // registered after the app's listener, so it sees whether the app prevented the default
    window.addEventListener("keydown", (e) => { if (e.code === "Space") g.push(e.defaultPrevented); });
  });
  return toScreen(page, [15.005, 45.005]);
}
const idle = (page: Page) => page.waitForFunction(() => !(window as any).__geoapp.map.isMoving(), undefined, { timeout: 5000 });
const count = async (page: Page) => (await labels(page)).size;
const prevented = (page: Page) => page.evaluate(() => (window as any).__space.splice(0) as boolean[]);
// MapLibre handlers the brush turns off in Paint mode
const handlers = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  return [map.dragRotate.isEnabled(), map.doubleClickZoom.isEnabled(), map.boxZoom.isEnabled()] as boolean[];
});
/** While Space is held: true if it acts as Pan (its keydown was prevented and the handlers are back). */
async function spacePan(page: Page): Promise<boolean> {
  const pan = await page.evaluate(() => { const g = (window as any).__space as boolean[]; return g[g.length - 1] === true; });
  expect(await handlers(page)).toEqual([pan, pan, pan]);
  return pan;
}
/** Paint mode's handler state: rotate, double-click zoom and box zoom off. */
const paintHandlers = async (page: Page) => expect(await handlers(page)).toEqual([false, false, false]);
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

  test("Space on a focused form control does its native action, not Pan; on the map it pans", async ({ page }) => {
    const c = await setup(page);
    await page.locator("#classes .class-name").first().focus();
    await expect(page.locator("#classes .class-name").first()).toBeFocused();
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(false); // held in a class name field, Space isn't Pan
    await page.keyboard.up("Space");
    await page.focus("#mode-pan");
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(false); // held on a button, Space isn't Pan
    await page.keyboard.up("Space"); // a button activates on release
    await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
    await page.focus("#mode-paint");
    await page.keyboard.press("Space");
    await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
    expect(await prevented(page)).toEqual([false, false, false]);

    await page.locator("#map canvas").focus();
    await expect(page.locator("#map canvas")).toBeFocused();
    const v0 = await view(page);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(true);
    await page.mouse.down();
    await moveTo(page, c, { x: c.x + 150, y: c.y + 40 }, 15);
    await page.mouse.up();
    await page.keyboard.up("Space");
    await idle(page);
    expect(moved(await view(page), v0)).toBeGreaterThan(0.5);
    expect(await count(page)).toBe(0);
    expect(await prevented(page)).toEqual([true]);
    await paintHandlers(page); // released: Paint mode again
  });

  test("after a mouse click on a button, held Space is Pan and presses nothing; tabbed to, Space presses it", async ({ page }) => {
    const c = await setup(page);
    const size = page.locator("#brush-size");
    await page.click("#brush-larger");
    await expect(page.locator("#brush-larger")).toBeFocused();
    const s1 = await size.textContent();
    expect(s1).not.toBe("Brush: 7 px");
    const v0 = await view(page);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(true);
    await page.mouse.down();
    await moveTo(page, c, { x: c.x + 150, y: c.y + 40 }, 15);
    await page.mouse.up();
    await page.keyboard.up("Space");
    await idle(page);
    expect(moved(await view(page), v0)).toBeGreaterThan(0.5);
    expect(await count(page)).toBe(0);
    await expect(size).toHaveText(s1!);
    await paintHandlers(page);
    expect((await prevented(page))[0]).toBe(true);

    await page.click("#mode-pan");
    await page.click("#mode-paint");
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(true); // Paint mode, Space held: Pan
    await page.keyboard.up("Space");
    await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
    await paintHandlers(page);
    expect(await prevented(page)).toEqual([true]);

    await page.click("#brush-smaller");
    await expect(size).toHaveText("Brush: 7 px");
    await page.keyboard.press("Tab");
    await expect(page.locator("#brush-larger")).toBeFocused();
    await prevented(page);
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(false); // tabbed to, Space is the button's
    await page.keyboard.up("Space");
    await expect(size).toHaveText(s1!);
    expect(await prevented(page)).toEqual([false]);

    await page.click("#brush-larger"); // a click on the tabbed-to button makes it mouse-focused again
    const s2 = await size.textContent();
    await page.keyboard.press("Space");
    await expect(size).toHaveText(s2!);
    expect(await prevented(page)).toEqual([true]);
  });

  test("after paint and erase strokes Paint mode keeps its handlers off, and Space in a class name field still isn't Pan", async ({ page }) => {
    const c = await setup(page);
    await paintHandlers(page);
    await stroke(page, [c, { x: c.x + 60, y: c.y }]);
    expect(await count(page)).toBeGreaterThan(0);
    await paintHandlers(page);
    await stroke(page, [c, { x: c.x + 60, y: c.y }], "right");
    expect(await count(page)).toBe(0);
    await paintHandlers(page);
    await page.locator("#classes .class-name").first().focus();
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(false);
    await page.keyboard.up("Space");
    await page.locator("#map canvas").focus();
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(true);
    await page.keyboard.up("Space");
    await paintHandlers(page);
    expect(await prevented(page)).toEqual([false, true]);
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
