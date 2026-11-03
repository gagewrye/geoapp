import { expect, test } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, paintMode, rgbFixture, stroke, toScreen } from "./helpers";

// Tester: spec 003 Strokes / criterion 10, Windows timing: contextmenu fires on the right release. The other
// contextmenu cases are brush-contextmenu-all.tester's (spec 052).

test.describe("contextmenu (criterion 10, tester)", () => {
  test("a contextmenu fired on the map just after an erase release (Windows timing) is prevented; on a class name field it isn't", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
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
});
