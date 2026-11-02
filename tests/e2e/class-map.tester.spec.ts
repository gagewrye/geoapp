import { expect, test } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, rgbFixture } from "./helpers";
import { applyMap, classList, effectiveTiles, importFile, upload } from "./seeding";

// Spec 047, tester edges: the same map file applied twice, and a later import keeps Apply class map usable.

test("the same map file can be applied twice, and a new import re-enables it with the new labels' classes", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(/^Seeded /);
  const before = await effectiveTiles(page);
  const map = JSON.stringify([{ value: 7, name: "Reef", colour: "#ff00ff" }]);
  await applyMap(page, map);
  await expect(message(page)).toHaveText("Class map applied to 1 classes.");
  await page.evaluate(() => { document.getElementById("message")!.textContent = ""; });
  await applyMap(page, map); // input was reset, so the same file fires change again
  await expect(message(page)).toHaveText("Class map applied to 1 classes.");
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Reef"]);
  expect(await effectiveTiles(page)).toEqual(before);

  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(/^Seeded /);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]);
  await expect(page.locator("#class-map")).toBeEnabled();
});
