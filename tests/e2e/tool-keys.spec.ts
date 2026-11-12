import { expect, test, type Page } from "@playwright/test";
import { jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, selectClass, stroke, toScreen } from "./helpers";

// Spec 033 criteria 4-6.
const pressed = (page: Page, id: string) => page.locator(`#mode-${id}`);
const tool = (page: Page) => page.locator("#status-tool");
/** Keys are shortcuts only outside text fields: take focus off the panel as a user clicking the map would, without painting. */
const unfocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

async function expectMode(page: Page, mode: "paint" | "erase" | "pan", label: string) {
  for (const m of ["paint", "erase", "pan"]) await expect(pressed(page, m)).toHaveAttribute("aria-pressed", String(m === mode));
  // spec 058 question 4: Erase names no class
  await expect(tool(page)).toHaveText(mode === "erase" ? "Erase · 7 px" : `${label} · Class 1 · 7 px`);
}

test("E then a left drag erases class 1 only; Ctrl+Z restores it (criterion 4)", async ({ page }) => {
  await setup(page);
  await jumpTo(page, [15, 45], 10);
  await paintMode(page);
  const c = await toScreen(page, [15.005, 45.005]);
  await selectClass(page, 1);
  await stroke(page, [{ x: c.x + 120, y: c.y }, { x: c.x + 180, y: c.y }]);
  await selectClass(page, 0);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  const before = await labels(page);
  const values = [...before.values()];
  expect(values.filter((v) => v === 1).length).toBeGreaterThan(0);
  expect(values.filter((v) => v === 2).length).toBeGreaterThan(0);

  await unfocus(page);
  await page.keyboard.press("e");
  await expect(pressed(page, "erase")).toHaveAttribute("aria-pressed", "true");
  await stroke(page, [c, { x: c.x + 60, y: c.y }, { x: c.x + 180, y: c.y }]);
  const after = await labels(page);
  expect(after).toEqual(new Map([...before].filter(([, v]) => v === 2)));

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => labels(page)).toEqual(before);
});

test("with labels hidden E shows them and selects Erase; hiding them in Erase selects Pan (criterion 5)", async ({ page }) => {
  await setup(page);
  const show = page.locator("#show-labels");
  await show.uncheck();
  await unfocus(page);
  await page.keyboard.press("e");
  await expect(show).toBeChecked();
  await expect(pressed(page, "erase")).toHaveAttribute("aria-pressed", "true");
  await show.uncheck();
  await expect(pressed(page, "pan")).toHaveAttribute("aria-pressed", "true");
  await expect(pressed(page, "erase")).toHaveAttribute("aria-pressed", "false");
});

test("the mode buttons and #status-tool follow B, E, P and Escape (criterion 6)", async ({ page }) => {
  await setup(page);
  await expect(pressed(page, "erase")).toBeEnabled();
  await unfocus(page);
  await expectMode(page, "pan", "Pan");
  for (const [key, mode, label] of [["b", "paint", "Paint"], ["e", "erase", "Erase"], ["p", "pan", "Pan"], ["e", "erase", "Erase"], ["Escape", "pan", "Pan"]] as const) {
    await page.keyboard.press(key);
    await expectMode(page, mode, label);
  }
  await pressed(page, "erase").click();
  await expectMode(page, "erase", "Erase");
});
