import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, labels, message, openApp, openRaster, paintMode, renameClass, rgbFixture, selectClass, settled, toScreen } from "./helpers";

// Spec 003 criterion 14 (classes). Criterion 13 (brush size) went with spec 073.

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
}
const names = (page: Page) => page.locator("#classes .class-name").evaluateAll((els) => els.map((e) => e.textContent));
const selected = (page: Page) => page.locator("#classes li").evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));
const hookClasses = (page: Page) => page.evaluate(() => (window as any).__geoapp.labels.classes.map((c: any) => ({ ...c })));

test.describe("classes (criterion 14)", () => {
  test("starts as Class 1 and Class 2 with Class 1 selected; select by click and by keys 1-9", async ({ page }) => {
    await setup(page);
    expect(await names(page)).toEqual(["Class 1", "Class 2"]);
    expect(await selected(page)).toBe(0);
    await selectClass(page, 1);
    expect(await selected(page)).toBe(1);
    for (let i = 0; i < 8; i++) await page.click("#class-add");
    expect(await names(page)).toHaveLength(10);
    await page.locator("#map canvas").focus();
    for (const k of ["9", "3", "1", "7"]) {
      await page.keyboard.press(k);
      expect(await selected(page)).toBe(Number(k) - 1);
    }
    // a selected class paints with its value
    await page.keyboard.press("3");
    const c = await toScreen(page, [15.005, 45.005]);
    await page.mouse.click(c.x, c.y);
    await settled(page);
    expect(new Set((await labels(page)).values())).toEqual(new Set([3]));
  });

  test("add and rename work; an empty or duplicate name shows the message and keeps the old name", async ({ page }) => {
    await setup(page);
    await page.click("#class-add");
    expect(await names(page)).toEqual(["Class 1", "Class 2", "Class 3"]);
    await renameClass(page, 2, "Mangrove");
    expect((await hookClasses(page)).map((c: any) => c.name)).toEqual(["Class 1", "Class 2", "Mangrove"]);
    for (const bad of ["", "   ", "Class 1"]) {
      await message(page).evaluate((e) => { e.textContent = ""; });
      await renameClass(page, 2, bad);
      await expect(message(page)).toHaveText(MESSAGES.className);
      await expect(page.locator("#classes .class-name").nth(2)).toHaveText("Mangrove");
      expect((await hookClasses(page))[2].name).toBe("Mangrove");
    }
  });
});
