import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, rgbFixture, stroke, toScreen } from "./helpers";

// Tester: spec 003 [C3] / criterion 10. contextmenu is prevented on the map while local imagery is
// open (MapLibre prevents it on its canvas anyway), and on the panel's class name field only within 500 ms of an erase stroke ending.

async function record(page: Page) {
  await page.evaluate(() => {
    const g = (window as any).__menus = [] as { onMap: boolean; prevented: boolean }[];
    // registered after the app's listener, so it sees whether the app prevented the default
    window.addEventListener("contextmenu", (e) => g.push({ onMap: (e.target as Element).closest("#map") !== null, prevented: e.defaultPrevented }));
  });
}
const menus = (page: Page) => page.evaluate(() => (window as any).__menus.splice(0) as { onMap: boolean; prevented: boolean }[]);
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

  test("more than 500 ms after an erase stroke a class name field's contextmenu isn't prevented; within 500 ms is recorded", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    await record(page);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await rightClickName(page); // within 500 ms: open question for Gage, recorded only
    const within = await menus(page);
    test.info().annotations.push({ type: "panel contextmenu within 500 ms of an erase", description: JSON.stringify(within.filter((m) => !m.onMap)) });
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await page.waitForTimeout(600);
    await rightClickName(page);
    expect((await menus(page)).filter((m) => !m.onMap)).toEqual([{ onMap: false, prevented: false }]);
  });
});
