import { expect, test, type Page } from "@playwright/test";
import { jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, stroke, toScreen, toucher, rawPointer } from "./helpers";

// Tester: spec 003 Modes rule (Space) / F6. How focus reached a control decides what Space does there: Tab and
// Shift+Tab keep Space native; mouse, touch and pen clicks leave Space as Pan; focus coming
// back after a file chooser or the discard confirm keeps how it was first focused.

const size = (page: Page) => page.locator("#brush-size");
// Space as Pan is a prevented keydown
const spacePan = (page: Page) => page.evaluate(() => { const g = (window as any).__space as boolean[]; return g[g.length - 1] === true; });

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 7);
  await page.evaluate(() => {
    const g = (window as any).__space = [] as boolean[];
    // registered after the app's listener, so it sees whether the app prevented the default
    window.addEventListener("keydown", (e) => { if (e.code === "Space") g.push(e.defaultPrevented); });
  });
}
const prevented = (page: Page) => page.evaluate(() => (window as any).__space.splice(0) as boolean[]);

/** Hold Space: true if it acted as Pan. Released afterwards. */
async function holdSpace(page: Page): Promise<boolean> {
  await page.keyboard.down("Space");
  const pan = await spacePan(page);
  await page.keyboard.up("Space");
  return pan;
}

test.describe("Space and focus (F6, tester)", () => {
  test("Shift+Tab onto the smaller-brush button: Space steps down, natively, not as Pan", async ({ page }) => {
    await setup(page);
    await page.click("#brush-larger");
    await page.click("#brush-larger");
    await expect(size(page)).toHaveText("31");
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#brush-smaller")).toBeFocused();
    await prevented(page);
    expect(await holdSpace(page)).toBe(false);
    await expect(size(page)).toHaveText("15");
    expect(await prevented(page)).toEqual([false]);
  });

  test("Tab through the panel: each button pressed by Space; then a mouse click elsewhere and Tab back keeps it native", async ({ page }) => {
    await setup(page);
    await page.click("#mode-pan"); // mouse-focused
    await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab"); // the strip's order is Pan, Paint, Erase (spec 035)
    await expect(page.locator("#mode-paint")).toBeFocused();
    await prevented(page);
    await page.keyboard.press("Space"); // in Pan mode MapLibre's handlers are on anyway, so watch the default
    await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
    expect(await prevented(page)).toEqual([false]);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator("#brush-smaller")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#brush-larger")).toBeFocused();
    expect(await holdSpace(page)).toBe(false);
    await expect(size(page)).toHaveText("15");
    // a mouse click on the map (focus leaves the panel), then keyboard back to the button
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 5, y: c.y }]);
    await page.click("#brush-smaller");
    await page.keyboard.press("Tab");
    await expect(page.locator("#brush-larger")).toBeFocused();
    expect(await holdSpace(page)).toBe(false);
    await expect(size(page)).toHaveText("15");
  });

  test("a touch tap and a pen tap on the larger-brush button leave Space as Pan, like a mouse click", async ({ page }) => {
    await setup(page);
    const box = (await page.locator("#brush-larger").boundingBox())!;
    const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    const touch = toucher(cdp);
    await touch("touchStart", [[1, p]]);
    await touch("touchEnd");
    await expect(size(page)).toHaveText("15");
    await expect(page.locator("#brush-larger")).toBeFocused();
    await prevented(page);
    expect(await holdSpace(page)).toBe(true);
    await expect(size(page)).toHaveText("15");
    expect(await prevented(page)).toEqual([true]);

    await page.keyboard.press("Tab"); // keyboard-focused somewhere else, then a pen tap back
    const pen = rawPointer(cdp, "pen");
    await pen("mouseMoved", p, false);
    await pen("mousePressed", p, true);
    await pen("mouseReleased", p, false);
    await expect(size(page)).toHaveText("31");
    await expect(page.locator("#brush-larger")).toBeFocused();
    expect(await holdSpace(page)).toBe(true);
    await expect(size(page)).toHaveText("31");
    expect(await prevented(page)).toEqual([true]);
    expect((await labels(page)).size).toBe(0);
  });

  test("Tab to Open GeoTIFF, Space opens the chooser; after the chooser and the discard confirm, Space still opens it", async ({ page }) => {
    await setup(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 20, y: c.y }]);
    expect((await labels(page)).size).toBeGreaterThan(0);
    await page.locator("#open-raster").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator("#open-raster")).toBeFocused();
    const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
    await page.keyboard.down("Space");
    expect(await spacePan(page)).toBe(false);
    await page.keyboard.up("Space");
    page.once("dialog", (d) => d.dismiss()); // Cancel keeps everything
    await (await chooser).setFiles({ ...rgbFixture(), name: "other.tif" });
    await expect.poll(() => page.evaluate(() => (document.getElementById("open-raster") as HTMLInputElement).value)).toBe("");
    expect((await labels(page)).size).toBeGreaterThan(0);
    await expect(page.locator("#open-raster")).toBeFocused();
    const again = page.waitForEvent("filechooser", { timeout: 3000 });
    await page.keyboard.press("Space");
    await again;
    expect((await prevented(page)).every((p) => !p)).toBe(true);
  });

  test("a mouse click on Open GeoTIFF, chooser closed, then Space: Pan, no chooser", async ({ page }) => {
    await setup(page);
    const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
    await page.click("#open-raster");
    await (await chooser).setFiles([]);
    let opened = false;
    page.on("filechooser", () => { opened = true; });
    await prevented(page);
    expect(await holdSpace(page)).toBe(true);
    await page.waitForTimeout(300);
    expect(opened).toBe(false);
    expect(await prevented(page)).toEqual([true]);
  });

  test("keyboard focus kept on a button while the page is hidden and shown again stays native", async ({ page, context }) => {
    await setup(page);
    await page.click("#brush-smaller");
    await page.keyboard.press("Tab");
    await expect(page.locator("#brush-larger")).toBeFocused();
    const other = await context.newPage();
    await other.bringToFront();
    await page.bringToFront();
    await expect(page.locator("#brush-larger")).toBeFocused();
    await prevented(page);
    expect(await holdSpace(page)).toBe(false);
    await expect(size(page)).toHaveText("7");
    expect(await prevented(page)).toEqual([false]);
    await other.close();
  });
});
