import { expect, test } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";
import { applyMap, download, importFile, noSavePicker, upload } from "./seeding";

// Spec 004 criterion 19 (privacy). Criterion 13 went with spec 073; criterion 18 with label-mask (spec 052).

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

test("importing and exporting labels make no network requests (criterion 19)", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await paintTwoClasses(page);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  await applyMap(page, JSON.stringify([{ value: 3, name: "three" }])); // spec 047: applied after the import
  await expect(message(page)).toHaveText("Class map applied to 1 classes.");
  await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
});
