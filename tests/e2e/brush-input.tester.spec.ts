import { expect, test, type Page } from "@playwright/test";
import { hoverFeatures, jumpTo, labels, message, moveTo, openApp, openRaster, paintMode, rgbFixture, selectClass, settled, stroke, toScreen, toucher, view } from "./helpers";

// Tester: spec 003 Strokes and "Pan, zoom, touch and pen" beyond criteria 10-12: presses during a stroke,
// Shift-drag, keyboard / control / pinch zoom, contextmenu. The middle button pans now (spec 009, navigation.spec.ts).

async function setup(page: Page, zoom = 9) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], zoom);
  return toScreen(page, [15.005, 45.005]);
}
const idle = (page: Page) => page.waitForFunction(() => !(window as any).__geoapp.map.isMoving(), undefined, { timeout: 5000 });
const count = async (page: Page) => (await labels(page)).size;

test("a right press during a left stroke is ignored: the stroke keeps painting and erases nothing", async ({ page }) => {
  const c = await setup(page);
  await selectClass(page, 1);
  await stroke(page, [{ x: c.x, y: c.y + 150 }, { x: c.x + 100, y: c.y + 150 }]); // class 2, ~20 rows below
  const before = await labels(page);
  await selectClass(page, 0);
  const cdp = await page.context().newCDPSession(page);
  const send = (type: string, p: { x: number; y: number }, button: string, buttons: number) =>
    cdp.send("Input.dispatchMouseEvent", { type: type as "mouseMoved", x: p.x, y: p.y, button: button as "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  await send("mouseMoved", c, "none", 0);
  await send("mousePressed", c, "left", 1);
  await send("mouseMoved", { x: c.x + 20, y: c.y }, "left", 1);
  await send("mousePressed", { x: c.x + 20, y: c.y }, "right", 3); // chord: right joins the left drag
  for (let i = 1; i <= 5; i++) await send("mouseMoved", { x: c.x + 20 + 10 * i, y: c.y + 30 * i }, "left", 3); // down over class 2
  await send("mouseReleased", { x: c.x + 70, y: c.y + 150 }, "right", 1);
  await send("mouseReleased", { x: c.x + 70, y: c.y + 150 }, "left", 0);
  await settled(page);
  const got = await labels(page);
  // paint may overwrite class 2 where the stroke crosses it, but the chorded right press erases nothing
  for (const [k] of before) expect([1, 2], k).toContain(got.get(k));
  expect([...got.values()].filter((v) => v === 1).length).toBeGreaterThan(before.size / 3);
  expect([...got].filter(([, v]) => v === 1).length).toBeGreaterThan(49);
});

test("Shift-drag in Paint mode doesn't box-zoom", async ({ page }) => {
  const c = await setup(page, 7);
  const z0 = (await view(page)).zoom;
  await page.keyboard.down("Shift");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await moveTo(page, c, { x: c.x + 150, y: c.y + 120 }, 15);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(400);
  await settled(page);
  expect((await view(page)).zoom).toBe(z0);
});

test("keyboard zoom and the navigation control work in Paint mode and paint nothing", async ({ page }) => {
  const c = await setup(page, 7);
  await page.mouse.move(c.x, c.y);
  await page.locator("#map canvas").focus();
  const z0 = (await view(page)).zoom;
  await page.keyboard.press("=");
  await page.waitForTimeout(400);
  await idle(page);
  const z1 = (await view(page)).zoom;
  expect(z1).toBeGreaterThan(z0 + 0.5);
  await expect(page.locator("#brush-size")).toHaveText("7"); // = / - zoom; [ ] size
  await page.locator(".maplibregl-ctrl-zoom-out").click();
  await page.waitForTimeout(400);
  await idle(page);
  expect((await view(page)).zoom).toBeLessThan(z1 - 0.5);
  expect(await count(page)).toBe(0);
});

test("a two-finger pinch (CDP) zooms, paints nothing and shows no footprint", async ({ page }) => {
  const c = await setup(page, 7);
  await page.mouse.move(c.x + 200, c.y + 200); // a mouse footprint somewhere else first
  const z0 = (await view(page)).zoom;
  const touch = toucher(await page.context().newCDPSession(page));
  await touch("touchStart", [[1, { x: c.x - 20, y: c.y }], [2, { x: c.x + 20, y: c.y }]]);
  for (let i = 1; i <= 12; i++) await touch("touchMove", [[1, { x: c.x - 20 - 8 * i, y: c.y }], [2, { x: c.x + 20 + 8 * i, y: c.y }]]);
  await touch("touchEnd");
  await idle(page);
  expect((await view(page)).zoom).toBeGreaterThan(z0 + 0.5);
  expect(await count(page)).toBe(0);
  expect(await hoverFeatures(page)).toHaveLength(0);
});

test("contextmenu: prevented on the map with local imagery open", async ({ page }) => {
  await openApp(page);
  const fire = (x: number, y: number) => page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)!;
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, [x, y] as const);
  const box = (await page.locator("#map canvas").boundingBox())!;
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  expect(await fire(box.x + 300, box.y + 300)).toBe(true);
});

test("a window blur ends the stroke (spec 003 Strokes): later held moves label nothing", async ({ page }) => {
  const c = await setup(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await moveTo(page, c, { x: c.x + 50, y: c.y }, 5);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await settled(page);
  const n = await count(page);
  expect(n).toBeGreaterThan(0);
  await moveTo(page, { x: c.x + 50, y: c.y }, { x: c.x + 50, y: c.y + 150 }, 15);
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await count(page)).toBe(n);
});
