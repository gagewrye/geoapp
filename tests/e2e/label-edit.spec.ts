import { expect, test } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, overlaysIdle, paintMode, paintOne, rgbStrip } from "./helpers";
import { applyMap, download, importFile, noSavePicker, upload } from "./seeding";

// Spec 004 criterion 19 (privacy). Criterion 13 went with spec 073; criterion 18 with label-mask (spec 052).

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

test("importing and exporting labels make no network requests (criterion 19)", async ({ page }) => {
  await noSavePicker(page);
  await openApp(page);
  // spec 072: the strip, as before; a raster read without geotiff.js's decoders leaves their chunks to the first import
  await openRaster(page, rgbStrip());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await paintOne(page); // labels, so the import replaces them (spec 072: one stroke, not paintTwoClasses)
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  await applyMap(page, JSON.stringify([{ value: 3, name: "three" }])); // spec 047: applied after the import
  await expect(message(page)).toHaveText("Class map applied to 1 classes.");
  await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.saving())).toBe(false); // the label saves the import and the map started have ended
  await overlaysIdle(page);
  expect(requests).toEqual([]);
});
