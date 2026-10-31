import { expect, test, type Page } from "@playwright/test";
import { editName, message, openApp, openRaster, paintMode, rgbFixture } from "./helpers";

// Spec 039 criteria 3-5.
async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await page.locator("#map canvas").focus();
}
const help = (page: Page) => page.locator("#help");
const isModal = (page: Page) => help(page).evaluate((d) => (d as HTMLDialogElement).open && d.matches(":modal"));

test("? opens the shortcut list as a modal; Escape closes it and keeps Paint; ? then Close closes it too (criterion 3)", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("?");
  expect(await isModal(page)).toBe(true);
  expect(await page.locator("#help .shortcut").count()).toBeGreaterThanOrEqual(19);
  for (const t of ["Paint", "Undo", "Redo", "Shortcuts"]) await expect(page.locator("#help")).toContainText(t);
  await page.keyboard.press("Escape");
  await expect(help(page)).not.toBeVisible();
  await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();
  await page.locator("#help button", { hasText: "Close" }).click();
  await expect(help(page)).not.toBeVisible();
  await page.locator("#help-button").click();
  expect(await isModal(page)).toBe(true);
  await page.keyboard.press("?");
  await expect(help(page)).not.toBeVisible();
});

test("? works before a raster opens", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("?");
  expect(await isModal(page)).toBe(true);
});

test("with the list open, B, H and ] change nothing (criterion 4)", async ({ page }) => {
  await setup(page);
  await page.click("#mode-pan");
  await page.locator("#map canvas").focus();
  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();
  for (const k of ["b", "h", "]"]) await page.keyboard.press(k);
  await page.keyboard.press("Escape");
  await expect(help(page)).not.toBeVisible();
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#show-labels")).toBeChecked();
  await expect(page.locator("#brush-size")).toHaveText("7");
});

test("typing ? in a class name puts it in the name (criterion 5)", async ({ page }) => {
  await setup(page);
  const field = await editName(page, 0);
  await page.keyboard.press("End");
  await page.keyboard.type("?");
  await expect(field).toHaveValue("Class 1?");
  await expect(help(page)).not.toBeVisible();
});
