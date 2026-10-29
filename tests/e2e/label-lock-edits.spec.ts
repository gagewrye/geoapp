import { expect, test } from "@playwright/test";
import { message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";
import { classList } from "./seeding";

// Spec 004 Locks: rename and recolour refuse while locked, even if their disabled inputs fire.

test("while an export holds the Save dialog, a forced rename or recolour changes no class", async ({ page }) => {
  await page.addInitScript(() => {
    const g = (window as any).__save = { opened: 0, cancel: null as null | (() => void) };
    (window as any).showSaveFilePicker = () => new Promise((_, rej) => {
      g.opened++;
      g.cancel = () => rej(new DOMException("The user aborted a request.", "AbortError"));
    });
  });
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await paintTwoClasses(page);
  const before = await classList(page);
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__save.opened)).toBe(1);
  await expect(page.locator("#classes .class-name").first()).toBeDisabled();
  await page.evaluate(() => {
    const name = document.querySelector<HTMLInputElement>("#classes .class-name")!;
    name.value = "renamed";
    name.dispatchEvent(new Event("change"));
    const colour = document.querySelector<HTMLInputElement>("#classes .class-colour")!;
    colour.value = "#123456";
    colour.dispatchEvent(new Event("input"));
  });
  expect(await classList(page)).toEqual(before);
  await expect(page.locator("#classes .class-name").first()).toHaveValue(before[0]!.name);
  await page.evaluate(() => (window as any).__save.cancel());
  await expect(page.locator("#classes .class-name").first()).toBeEnabled();
});
