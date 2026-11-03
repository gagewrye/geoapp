import { expect, test } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { jumpTo, message, openApp, openRaster, paintMode, paintTwoClasses, path, rgbFixture, selectClass, stroke, toScreen } from "./helpers";
import { applyMap, download, effectiveTiles, expectNoNodata, importFile, inNodata, noSavePicker, nodataImagery, storeTiles, upload } from "./seeding";

// Spec 004 criteria 13 (its e2e part) and 19 (privacy). Criterion 18 (edit): label-mask (spec 052).

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

test("after strokes across a nodata block and an import, no imagery-nodata pixel is labelled (criterion 13)", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [14.3, 45.75], 8);
  await page.click("#brush-larger");
  for (const [i, lat] of [[0, 45.9], [1, 45.6]] as const) {
    await selectClass(page, i);
    await stroke(page, path(await toScreen(page, [13.8, lat]), await toScreen(page, [14.8, lat]), 12));
  }
  expectNoNodata(await storeTiles(page), 1000, inNodata);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  expectNoNodata(await effectiveTiles(page), 1000, inNodata);
});

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
