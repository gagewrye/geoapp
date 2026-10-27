import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, rgbFixture, stroke, toScreen } from "./helpers";

// Tester: spec 003 [C3] / criterion 10. contextmenu is prevented on the map while local imagery is
// open (MapLibre prevents it on its canvas anyway), and never on the panel, even within 500 ms of an
// erase stroke ending (Gage, 2026-10-27).

type Menu = { onMap: boolean; prevented: boolean; sinceErase: number };
async function record(page: Page) {
  await page.evaluate(() => {
    const g = (window as any).__menus = [] as unknown[];
    let erased = -Infinity;
    window.addEventListener("pointerup", (e) => { if (e.button === 2) erased = performance.now(); });
    // registered after the app's listener, so it sees whether the app prevented the default
    window.addEventListener("contextmenu", (e) => g.push({
      onMap: (e.target as Element).closest("#map") !== null, prevented: e.defaultPrevented, sinceErase: performance.now() - erased,
    }));
  });
}
const menus = async (page: Page) => (await page.evaluate(() => (window as any).__menus.splice(0) as Menu[]))
  .map(({ onMap, prevented }) => ({ onMap, prevented }));
const rawMenus = (page: Page) => page.evaluate(() => (window as any).__menus.splice(0) as Menu[]);
const rightClickName = (page: Page) => page.locator("#classes .class-name").first().click({ button: "right" });

test.describe("contextmenu (criterion 10 [C3], tester)", () => {
  test("imagery open: prevented on the map in Paint and Pan mode; never on a class name field away from an erase", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    await record(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await rightClickName(page);
    await page.mouse.click(c.x, c.y, { button: "right" });
    await page.click("#mode-pan");
    await page.mouse.click(c.x, c.y, { button: "right" });
    await page.click("#mode-paint");
    expect(await menus(page)).toEqual([
      { onMap: false, prevented: false },
      { onMap: true, prevented: true },
      { onMap: true, prevented: true },
    ]);
  });

  test("within 500 ms of an erase stroke a class name field's contextmenu isn't prevented and the map's is", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    await record(page);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await rawMenus(page); // the erase stroke's own press, on the map
    await rightClickName(page);
    const name = await rawMenus(page);
    expect(name.map((m) => [m.onMap, m.prevented])).toEqual([[false, false]]);
    expect(name[0]!.sinceErase).toBeLessThan(500);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await rawMenus(page);
    await page.mouse.click(c.x, c.y + 60, { button: "right" });
    const map = await rawMenus(page);
    expect(map.map((m) => [m.onMap, m.prevented])).toEqual([[true, true]]);
    expect(map[0]!.sinceErase).toBeLessThan(500);
  });

  test("a contextmenu fired on the map just after an erase release (Windows timing) is prevented; on a class name field it isn't", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    const name = (await page.locator("#classes .class-name").first().boundingBox())!;
    // Windows fires contextmenu on the right release, at the release point; dispatched in the same task as the check
    const lateMenu = (x: number, y: number) => page.evaluate(([x, y]) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
      document.elementFromPoint(x, y)!.dispatchEvent(e);
      return e.defaultPrevented;
    }, [x, y] as const);
    const end = { x: c.x + 40, y: c.y };
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(end.x, end.y);
    await page.mouse.up({ button: "right" });
    expect(await lateMenu(end.x, end.y)).toBe(true);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(name.x + 4, name.y + 4); // released over the panel
    await page.mouse.up({ button: "right" });
    expect(await lateMenu(name.x + 4, name.y + 4)).toBe(false);
  });

  test("more than 500 ms after an erase stroke a class name field's contextmenu isn't prevented", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    await record(page);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await page.waitForTimeout(600);
    await rightClickName(page);
    expect((await menus(page)).filter((m) => !m.onMap)).toEqual([{ onMap: false, prevented: false }]);
  });
});
