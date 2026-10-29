import { expect, test } from "@playwright/test";
import { toLonLat } from "../../src/core/crs";
import { CLASS_GRID, classFile } from "../unit/helpers/labelFiles";
import { jumpTo, labels, message, openApp, openRaster, paintTwoClasses, path, rgbFixture, selectClass, stroke, toScreen, type LngLat } from "./helpers";
import { classList, download, expectNoNodata, importFile, inNodata, noSavePicker, nodataImagery, storeTiles, upload } from "./seeding";

// Spec 004 criteria 18 (edit), 13 (its e2e part) and 19 (privacy).

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
/** Lon/lat of a class raster pixel position (col, row may be fractional). */
const fileLonLat = (c: number, r: number): LngLat => toLonLat(32633, CLASS_GRID.gt[0] + c * CLASS_GRID.gt[1], CLASS_GRID.gt[3] + r * CLASS_GRID.gt[5]);
const count = (m: Map<string, number>, v: number) => [...m.values()].filter((x) => x === v).length;

test("after an import, a right drag clears the selected class in a seeded area and a left drag paints (criterion 18)", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]);
  // file block cols 24..47, rows 0..19 holds 3, which is label value 2 ("Class 3")
  const centre = fileLonLat(36, 10);
  await jumpTo(page, centre, 7);
  const before = await labels(page);
  await selectClass(page, 1);
  const across = path(await toScreen(page, fileLonLat(30, 10)), await toScreen(page, fileLonLat(42, 10)), 8);
  await stroke(page, across, "right");
  const erased = await labels(page);
  expect(count(erased, 2)).toBeLessThan(count(before, 2) - 100);
  expect([count(erased, 1), count(erased, 3)]).toEqual([count(before, 1), count(before, 3)]);
  expect([...erased].filter(([k, v]) => before.get(k) !== v)).toEqual([]); // erasing changed nothing else
  // paint Class 7 (value 3) back over part of it
  await selectClass(page, 2);
  await stroke(page, path(await toScreen(page, fileLonLat(33, 8)), await toScreen(page, fileLonLat(39, 8)), 6));
  const painted = await labels(page);
  expect(count(painted, 3)).toBeGreaterThan(count(erased, 3));
});

test("after strokes across a nodata block and a Merge import, no imagery-nodata pixel is labelled (criterion 13)", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [14.3, 45.75], 8);
  await page.click("#brush-larger");
  for (const [i, lat] of [[0, 45.9], [1, 45.6]] as const) {
    await selectClass(page, i);
    await stroke(page, path(await toScreen(page, [13.8, lat]), await toScreen(page, [14.8, lat]), 12));
  }
  expectNoNodata(await storeTiles(page), 1000, inNodata);
  await importFile(page, upload("classes.tif", classFile("255"))); // Merge: no confirm
  await expect(message(page)).toHaveText(seeded);
  expectNoNodata(await storeTiles(page), 1000, inNodata);
});

test("importing and exporting labels make no network requests (criterion 19)", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintTwoClasses(page);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.setInputFiles("#class-map", upload("map.json", JSON.stringify([{ value: 3, name: "three" }])));
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
});
