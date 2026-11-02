import { expect, test, type Page } from "@playwright/test";
import { paletteColour } from "../../src/core/classes";
import { toLonLat } from "../../src/core/crs";
import { CLASS_GRID, classFile, itemFile } from "../unit/helpers/labelFiles";
import { hideBasemap, jumpTo, message, openApp, openRaster, paintMode, pixelAt, rgbFixture, tileKeysStored, toScreen, type LngLat } from "./helpers";
import { applyMap, classList, effectiveTiles, holdIdb, importFile, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

// Spec 047 criteria 6-10: Apply class map, after Import labels, renames and recolours the imported classes only.

const seeded = /^Seeded \d+ pixels in \d+ classes\./;
const classMap = (page: Page) => page.locator("#class-map");
const names = async (page: Page) => (await classList(page)).map((c) => c.name);

async function setup(page: Page) {
  page.on("dialog", (d) => void d.accept()); // "Replace labels?", the restore offer and leaving with unsaved labels
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}
async function importClasses(page: Page) {
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const near = (got: number[], want: number[]) => want.every((v, i) => Math.abs(got[i]! - v) <= 3);
/** Inside the 0/3/7 file's value-3 block (file cols 24..47, rows 0..19). */
const THREE = toLonLat(32633, CLASS_GRID.gt[0] + 36 * CLASS_GRID.gt[1], CLASS_GRID.gt[3] + 10 * CLASS_GRID.gt[5]) as LngLat;

test("Apply class map comes after Import labels, and is enabled only once labels are imported (criterion 6)", async ({ page }) => {
  await setup(page);
  const order = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#topbar input, #topbar button")].map((e) => e.id);
    return [items.indexOf("import-labels"), items.indexOf("class-map")];
  });
  expect(order[0]).toBeGreaterThanOrEqual(0);
  expect(order[1]).toBeGreaterThan(order[0]!);
  await expect(page.locator("label.file", { has: classMap(page) })).toHaveText("Apply class map");
  await expect(classMap(page)).toBeDisabled();
  await importClasses(page);
  await expect(classMap(page)).toBeEnabled();
});

test("apply renames and recolours by raw value; the mask repaints, painted tiles and Undo are untouched (criterion 7)", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await hideBasemap(page);
  await jumpTo(page, THREE, 8);
  const p = await toScreen(page, THREE);
  const under = await pixelAt(page, p);
  await importClasses(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [16.005, 44.005]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 30, a.y + 20);
  await page.mouse.up();
  await expect.poll(async () => (await tileKeysStored(page)).length).toBeGreaterThan(0);
  await expect(page.locator("#import-labels")).toBeEnabled();
  const painted = await storeTiles(page);

  await applyMap(page, JSON.stringify([{ value: 3, name: "Water", colour: "#0000ff" }, { value: 0, name: "Sand" }]));
  await expect(message(page)).toHaveText("Class map applied to 2 classes.");
  expect(await classList(page)).toEqual([{ name: "Sand", colour: paletteColour(0) }, { name: "Water", colour: "#0000ff" }, { name: "Class 7", colour: paletteColour(2) }]);
  expect(await storeTiles(page)).toEqual(painted);

  await jumpTo(page, THREE, 8);
  await page.locator("#brush-panel").hover({ position: { x: 4, y: 4 } }); // no hover footprint over the probe
  await expect.poll(async () => near(await pixelAt(page, p), rgb("#0000ff").map((v, i) => 0.6 * v + 0.4 * under[i]!))).toBe(true);

  await page.click("#undo");
  await expect.poll(() => tileKeysStored(page)).toEqual([]);
});

test("the real case: a file's own table, and a map of values 0-7 under other names (criterion 8)", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  const table = Array.from({ length: 8 }, (_, i) => ({ name: `t${i + 1}`, colour: paletteColour(i) }));
  await importFile(page, upload("labels-last.tif", await itemFile((c, r) => ((Math.floor(c / 24) + Math.floor(r / 20)) % 8) + 1, table)));
  await expect(message(page)).toHaveText(seeded);
  expect(await names(page)).toEqual(table.map((t) => t.name));
  const before = await effectiveTiles(page);
  await applyMap(page, JSON.stringify([{ value: 0, name: "mangrove" }, ...Array.from({ length: 7 }, (_, i) => ({ value: i + 1, name: `m${i + 1}` }))]));
  await expect(message(page)).toHaveText("Class map applied to 7 classes. Skipped: [0].value has no class in these labels.");
  expect(await names(page)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "t8"]);
  expect(await effectiveTiles(page)).toEqual(before);
});

test("a map that isn't JSON says so in red and changes nothing (criterion 9)", async ({ page }) => {
  await setup(page);
  await importClasses(page);
  const before = await classList(page);
  await applyMap(page, "{not json");
  await expect(message(page)).toHaveText("Class map matched no class. Skipped: JSON is not valid JSON.");
  await expect(message(page)).toHaveClass(/\berror\b/);
  expect(await classList(page)).toEqual(before);
});

test("Apply class map is disabled during an import, an export and a pending restore (criterion 10)", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const g = (window as any).__save = { cancel: null as null | (() => void) };
    (window as any).showSaveFilePicker = () => new Promise((_, rej) => { g.cancel = () => rej(new DOMException("The user aborted a request.", "AbortError")); });
  });
  await setup(page);
  await importClasses(page);
  await expect(classMap(page)).toBeEnabled();

  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await expect(classMap(page)).toBeDisabled();
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expect(classMap(page)).toBeEnabled();

  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__save.cancel !== null)).toBe(true);
  await expect(classMap(page)).toBeDisabled();
  await page.evaluate(() => (window as any).__save.cancel());
  await expect(classMap(page)).toBeEnabled();

  await expect(page.locator("#save-state")).toHaveText(/^Saved /, { timeout: 15_000 });
  await page.addInitScript(holdIdb);
  await page.reload();
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(classMap(page)).toBeDisabled();
  await page.evaluate(() => { (window as any).__idb.get.open(); (window as any).__idb.tiles.open(); });
  await expect(message(page)).toHaveText("Labels restored.");
  await expect(classMap(page)).toBeEnabled();
});
