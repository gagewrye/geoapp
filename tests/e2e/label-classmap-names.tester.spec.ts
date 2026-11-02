import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";
import { importFile, openFileGate, pauseLabelFile, upload } from "./seeding";

// Tester checks of spec 004's build clarifications: selecting during an import (criterion 16). Spec 047 removed the
// import-time class map, so its checks here went (Apply class map: class-map.spec.ts).

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
}

test("while an import runs, selecting a class still works", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  await pauseLabelFile(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  await expect(page.locator("#class-add")).toBeDisabled();
  await page.locator("#classes li").nth(1).click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#classes li").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.keyboard.press("1");
  await expect(page.locator("#classes li").nth(0)).toHaveAttribute("aria-selected", "true");
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
});
