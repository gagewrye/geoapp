import { expect, test, type Page } from "@playwright/test";
import { editName, message, openApp, openRaster, paintMode, rgbFixture } from "./helpers";

// Spec 036 criteria 5 and 6. Criterion 9 (Home in the slider): redo and layout (spec 052).
async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}
const selected = (page: Page) => page.locator("#classes li").evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));

test("typing b2e] while renaming goes into the name and changes no mode, class or brush size (criterion 5)", async ({ page }) => {
  await setup(page);
  await page.click("#class-add");
  const field = await editName(page, 0);
  await page.keyboard.press("End");
  await page.keyboard.type("b2e]");
  await expect(field).toHaveValue("Class 1b2e]");
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  expect(await selected(page)).toBe(0);
  await expect(page.locator("#brush-size")).toHaveText("7");
  await page.keyboard.press("Escape"); // cancels, and doesn't reach the Pan key
  await expect(page.locator("#classes .class-name").first()).toHaveText("Class 1");
});

test("Escape while renaming in Paint mode keeps Paint (criterion 5, spec 033's Pan key)", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await editName(page, 1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
});

test("with 40 classes the list is taller than 40vh, and the 9th class selected by key is in view (criterion 6)", async ({ page }) => {
  await setup(page);
  for (let i = 2; i < 40; i++) await page.click("#class-add");
  await expect(page.locator("#classes li")).toHaveCount(40);
  const { list, vh } = await page.evaluate(() => ({ list: document.getElementById("classes")!.clientHeight, vh: window.innerHeight }));
  expect(list).toBeGreaterThan(0.4 * vh);
  await page.locator("#classes").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.locator("#map canvas").focus();
  await page.keyboard.press("9");
  expect(await selected(page)).toBe(8);
  await expect(page.locator("#classes li").nth(8)).toBeInViewport();
  const inList = await page.locator("#classes").evaluate((el) => {
    const r = el.getBoundingClientRect(), li = el.children[8]!.getBoundingClientRect();
    return li.top >= r.top - 0.5 && li.bottom <= r.bottom + 0.5;
  });
  expect(inList).toBe(true);
});
