import { expect, test, type Page } from "@playwright/test";
import { paletteColour } from "../../src/core/classes";
import { tileWindows } from "../../src/core/grid";
import { seedLut, sourceCells } from "../../src/core/seed";
import { MESSAGES } from "../../src/ui/messages";
import { aefShapedFile, CLASS_GRID, CLASS_MAP, classFile, classItemFile, classValue, ITEM_CLASSES, rgbClassFile, uint16ClassFile, writeFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, paintMode, paintTwoClasses, RGB_GRID, rgbFixture } from "./helpers";
import { classList, effectiveTiles, importFile, storeTiles, upload } from "./seeding";

// Spec 004 criteria 12 (classes) and 15 (refusals), on spec 001's EPSG:4326 fixture.

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

  test("with a class map the list takes the map's names, and its unlisted values stay unlabelled", async ({ page }) => {
    await setup(page);
    await importFile(page, upload("classes.tif", classFile("255")), upload("map.json", JSON.stringify(CLASS_MAP)));
    await expect(message(page)).toHaveText(seeded);
    expect(await classList(page)).toEqual([{ name: "Seven", colour: "#123456" }, { name: "Three", colour: paletteColour(1) }]);
    // brute force: the map's value 7 -> 1, 3 -> 2; 0 and 255 unlisted -> unlabelled
    const lut = seedLut(CLASS_MAP, [1, 2]);
    const tiles = await effectiveTiles(page); // spec 014: the file is a base
    let bad = 0, labelled = 0;
    for (const w of tileWindows(1000, 1000)) {
      const t = tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height);
      const cells = sourceCells(RGB_GRID, CLASS_GRID, w);
      t.forEach((v, i) => { const want = cells[2 * i]! < 0 ? 0 : lut[classValue(cells[2 * i]!, cells[2 * i + 1]!)]; if (v !== want) bad++; if (v) labelled++; });
    }
    expect(bad).toBe(0);
    expect(labelled).toBeGreaterThan(10000);
  });

  test("the 0/3/7 file gives Class 0, Class 3 and Class 7; without GDAL_NODATA 255 becomes a class too", async ({ page }) => {
    await setup(page);
    await importFile(page, upload("classes.tif", classFile("255")));
    await expect(message(page)).toHaveText(seeded);
    expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]);
    await page.reload();
    await setup(page);
    await importFile(page, upload("classes-nond.tif", classFile(null)));
    await expect(message(page)).toHaveText(seeded);
    expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7", "Class 255"]);
  });

  test("an invalid class map shows the message and changes nothing", async ({ page }) => {
    await setup(page, true);
    await paintTwoClasses(page);
    const before = { tiles: await storeTiles(page), list: await classList(page) };
    await importFile(page, upload("classes.tif", classFile("255")), upload("map.json", JSON.stringify([{ value: 3, name: "x" }, { value: 255, name: "y" }])));
    await expect(message(page)).toHaveText(MESSAGES.classTable("[1].value"));
    expect(await storeTiles(page)).toEqual(before.tiles);
    expect(await classList(page)).toEqual(before.list);
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
