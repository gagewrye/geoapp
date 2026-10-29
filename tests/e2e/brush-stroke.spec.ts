import { expect, test, type Page } from "@playwright/test";
import { jumpTo, labels, message, moveTo, openApp, openRaster, paintMode, rawPointer, rgbFixture, settled, toScreen, view, type Xy } from "./helpers";

// Spec 003 criterion 11: how a stroke ends, and pen input.

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  return toScreen(page, [15.005, 45.005]);
}
const count = async (page: Page) => (await labels(page)).size;

test.describe("stroke end (criterion 11)", () => {
  test("releasing over the panel ends the stroke; later moves label nothing", async ({ page }) => {
    const c = await setup(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await moveTo(page, c, { x: c.x + 50, y: c.y }, 5);
    const panel = (await page.locator("#panel").boundingBox())!;
    await moveTo(page, { x: c.x + 50, y: c.y }, { x: panel.x + panel.width / 2, y: c.y }, 10);
    await page.mouse.up();
    await settled(page);
    const n = await count(page);
    expect(n).toBeGreaterThan(0);
    await moveTo(page, { x: panel.x + panel.width / 2, y: c.y }, { x: c.x + 150, y: c.y + 120 }, 20);
    await page.waitForTimeout(100);
    expect(await count(page)).toBe(n);
  });

  test("a pointercancel ends the stroke; later held moves label nothing", async ({ page }) => {
    const c = await setup(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await moveTo(page, c, { x: c.x + 50, y: c.y }, 5);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, pointerType: "mouse", isPrimary: true })));
    await settled(page);
    const n = await count(page);
    expect(n).toBeGreaterThan(0);
    await moveTo(page, { x: c.x + 50, y: c.y }, { x: c.x + 50, y: c.y + 150 }, 15);
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await count(page)).toBe(n);
  });

  test("a move with buttons 0 (CDP) ends the stroke; later held moves label nothing", async ({ page }) => {
    const c = await setup(page);
    const cdp = await page.context().newCDPSession(page);
    const mouse = rawPointer(cdp);
    await mouse("mouseMoved", c, false);
    await mouse("mousePressed", c, true);
    for (let i = 1; i <= 5; i++) await mouse("mouseMoved", { x: c.x + 10 * i, y: c.y }, true);
    await mouse("mouseMoved", { x: c.x + 52, y: c.y }, false); // the release was lost
    await settled(page);
    const n = await count(page);
    expect(n).toBeGreaterThan(0);
    for (let i = 1; i <= 10; i++) await mouse("mouseMoved", { x: c.x + 50, y: c.y + 15 * i }, true);
    await mouse("mouseReleased", { x: c.x + 50, y: c.y + 150 }, false);
    await page.waitForTimeout(100);
    expect(await count(page)).toBe(n);
  });
});

test.describe("pen (criterion 11)", () => {
  async function penDrag(page: Page, button: "left" | "right", pts: Xy[]) {
    const cdp = await page.context().newCDPSession(page);
    const pen = rawPointer(cdp, "pen", button);
    await pen("mouseMoved", pts[0]!, false);
    await pen("mousePressed", pts[0]!, true);
    for (const p of pts.slice(1)) await pen("mouseMoved", p, true);
    await pen("mouseReleased", pts.at(-1)!, false);
    await settled(page);
  }

  test("a tip drag paints and a barrel (right) drag erases; the map doesn't move", async ({ page }) => {
    const c = await setup(page);
    const v0 = await view(page);
    await penDrag(page, "left", [c, { x: c.x + 30, y: c.y }, { x: c.x + 60, y: c.y }]);
    const painted = await labels(page);
    expect(painted.size).toBeGreaterThan(49);
    expect(new Set(painted.values())).toEqual(new Set([1]));
    await penDrag(page, "right", [{ x: c.x - 30, y: c.y }, { x: c.x + 30, y: c.y }, { x: c.x + 100, y: c.y }]);
    expect(await count(page)).toBe(0);
    expect(await view(page)).toEqual(v0);
  });

  test("a hovering pen shows the footprint", async ({ page }) => {
    const c = await setup(page);
    const cdp = await page.context().newCDPSession(page);
    const pen = rawPointer(cdp, "pen");
    await pen("mouseMoved", c, false);
    await pen("mouseMoved", { x: c.x + 3, y: c.y }, false);
    await expect.poll(() => page.evaluate(async () => ((await (window as any).__geoapp.map.getSource("brush-hover")?.getData()) as any)?.features.length ?? 0)).toBe(1);
    expect(await count(page)).toBe(0);
  });
});
