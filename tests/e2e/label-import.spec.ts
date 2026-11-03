import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { aefShapedFile, classItemFile, ITEM_CLASSES, rgbClassFile, uint16ClassFile, writeFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";
import { classList, importFile, storeTiles, upload } from "./seeding";

// Spec 004 criteria 12 (classes) and 15 (refusals), on spec 001's EPSG:4326 fixture. The import-time class map's
// tests went with it (spec 047; Apply class map: class-map.spec.ts).

const watched = new WeakSet<Page>();
/** Opens the fixture; with no labels an import asks nothing, so a dialog fails the test unless `replace` accepts "Replace labels?". */
// Spec 031: a reload with unsaved labels asks to leave (accepted), and reopening offers them back (declined: a fresh start).
async function setup(page: Page, replace = false) {
  if (!watched.has(page)) {
    watched.add(page);
    page.on("dialog", (d) => {
      if (d.type() === "beforeunload") return void d.accept();
      if (d.message().startsWith("Restore labels saved ")) return void d.dismiss();
      if (!replace || d.message() !== MESSAGES.replace) throw new Error(`unexpected dialog ${d.message()}`);
      void d.accept();
    });
  }
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
}
const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

test.describe("classes (criterion 12)", () => {
  test("the CLASS_ITEM file takes names and colours from the item", async ({ page }) => {
    await setup(page);
    await importFile(page, upload("item.tif", await classItemFile()));
    await expect(message(page)).toHaveText(seeded);
    expect(await classList(page)).toEqual(ITEM_CLASSES);
  });
});

test.describe("refusals (criterion 15)", () => {
  test("3-band, 16-bit and AlphaEarth-shaped files, an unsupported CRS and a file off the imagery each show their message and change nothing", async ({ page }) => {
    await setup(page, true);
    await paintTwoClasses(page);
    const before = { tiles: await storeTiles(page), list: await classList(page) };
    const unchanged = async () => {
      expect(await storeTiles(page)).toEqual(before.tiles);
      expect(await classList(page)).toEqual(before.list);
    };
    for (const f of [upload("rgb.tif", rgbClassFile()), upload("u16.tif", uint16ClassFile()), upload("aef.tif", aefShapedFile())]) {
      await page.evaluate(() => { document.getElementById("message")!.textContent = ""; });
      await importFile(page, f);
      await expect(message(page)).toHaveText(MESSAGES.labelFile);
      await unchanged();
    }
    // the unsupported CRS gives the message Open GeoTIFF gives for the same file
    const lambert = writeFile({ width: 10, height: 10, epsg: 2154, gt: [700000, 10, 0, 6600000, 0, -10] }, 1, new Uint8Array(100).fill(3), undefined,
      { GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 2154 });
    await importFile(page, upload("l93.tif", lambert));
    await expect(message(page)).toHaveText(/EPSG:2154/);
    const said = await message(page).textContent();
    await unchanged();
    // a 3 x 3 file far east of the imagery
    const off = writeFile({ width: 3, height: 3, epsg: 32633, gt: [500000, 100, 0, 3000000, 0, -100] }, 1, new Uint8Array(9).fill(3));
    await importFile(page, upload("off.tif", off));
    await expect(message(page)).toHaveText(MESSAGES.noSeed);
    await unchanged();
    await openRaster(page, upload("l93.tif", lambert));
    await expect(message(page)).toHaveText(said!);
  });
});
