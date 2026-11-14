import { expect, test, type Dialog, type Page } from "@playwright/test";
import {
  anotherRaster, jumpTo, message, openApp, openRaster, paintMode, paintTwoClasses, path, rgbFixture, selectClass, stroke, tileKeysStored, toScreen,
} from "./helpers";
import { at, classList, download, effectiveTiles, importFile, maskFile, noSavePicker, storeTiles, tileDiff } from "./seeding";

// Spec 031 criteria 6-9: labels survive a reload in this browser.

const saveState = (page: Page) => page.locator("#save-state");
const restorePrompt = /^Restore labels saved .+ for rgb4326\.tif\?$/;

/** Accepts every dialog and logs it as "type: message". */
function dialogs(page: Page): string[] {
  const log: string[] = [];
  page.on("dialog", (d: Dialog) => { log.push(`${d.type()}: ${d.message()}`); void d.accept(); });
  return log;
}

async function open(page: Page, file = rgbFixture()) {
  await openRaster(page, file);
  await expect(message(page)).toHaveText("Raster opened.");
}

/** Waits until the latest change is saved: no save scheduled or in flight (spec 072), and "Saved". */
async function saved(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.saving()), { timeout: 15_000 }).toBe(false);
  await expect(saveState(page)).toHaveText(/^Saved /);
}

async function reload(page: Page) {
  await page.reload();
  await expect(page.locator("#map[data-ready=true]")).toBeVisible();
}

const selected = (page: Page) => page.locator("#classes li[aria-selected=true]").evaluate((li) => [...li.parentElement!.children].indexOf(li));

// Criterion 6 is split in two (spec 072): each part has one Saved and one reload.
test("criterion 6, tiles and classes: paint and rename; after Saved and a reload, accepting the restore brings back the tiles and classes; paint still works", async ({ page }) => {
  const log = dialogs(page);
  await openApp(page);
  await open(page);
  await paintMode(page);
  await paintTwoClasses(page, ["Mangrove", "Water"]);
  await saved(page);
  const tiles = await storeTiles(page);
  expect(tiles.size).toBeGreaterThan(0);
  const classes = await classList(page);

  await reload(page);
  expect(log).toEqual([]); // nothing unsaved: no beforeunload
  await open(page, { ...rgbFixture(), name: "renamed.tif" });
  await expect(message(page)).toHaveText("Labels restored.");
  expect(log).toHaveLength(1);
  expect(log[0]).toMatch(/^confirm: /);
  expect(log[0]!.slice(9)).toMatch(restorePrompt);
  const back = await storeTiles(page);
  expect([...back.keys()].sort()).toEqual([...tiles.keys()].sort());
  for (const [k, t] of tiles) expect(Buffer.from(back.get(k)!).equals(Buffer.from(t)), k).toBe(true);
  expect(await classList(page)).toEqual(classes);

  await paintMode(page);
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [15.005, 47.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  expect((await tileKeysStored(page)).length).toBeGreaterThan(tiles.size);
});

test("criterion 6, selection and opacity: class 2 selected and opacity 30%; after Saved and a reload, accepting the restore brings both back", async ({ page }) => {
  const log = dialogs(page);
  await openApp(page);
  await open(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 6);
  await selectClass(page, 1);
  const a = await toScreen(page, [18.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]); // a label, so the session saves (spec 031)
  await page.locator("#label-opacity").fill("30");
  await saved(page);
  expect(await selected(page)).toBe(1);

  await reload(page);
  expect(log).toEqual([]); // nothing unsaved: no beforeunload
  await expect(page.locator("#label-opacity")).toHaveValue("60"); // spec 016 criterion 3 without a restore
  await open(page, { ...rgbFixture(), name: "renamed.tif" });
  await expect(message(page)).toHaveText("Labels restored.");
  expect(log).toHaveLength(1);
  expect(log[0]!.slice(9)).toMatch(restorePrompt);
  expect(await selected(page)).toBe(1);
  await expect(page.locator("#label-opacity")).toHaveValue("30");
  await expect(page.locator("#label-opacity-text")).toHaveText("30%");
});

test("an imported mask plus a stroke: after the restore the mask and the stroke show, and an Export equals one made before the reload (criterion 7)", async ({ page }) => {
  await noSavePicker(page);
  const log = dialogs(page);
  await openApp(page);
  await open(page);
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(/^Seeded \d+ pixels in \d+ classes\.$/);
  await paintMode(page);
  await jumpTo(page, at(400, 400), 10);
  await selectClass(page, 2);
  await stroke(page, path(await toScreen(page, at(380.5, 400.5)), await toScreen(page, at(420.5, 410.5)), 8));
  await saved(page);
  const before = await effectiveTiles(page);
  const exported = await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");

  await reload(page);
  await open(page);
  await expect(message(page)).toHaveText("Labels restored.");
  expect(log.filter((l) => l.startsWith("beforeunload"))).toEqual([]);
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getLayer("mask") !== undefined)).toBe(true);
  expect(tileDiff(await effectiveTiles(page), before)).toEqual([]);
  const again = await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  expect(again.equals(exported)).toBe(true);
});

test("opening a different raster after a save shows no prompt, and the first raster's session still restores afterwards (criterion 8)", async ({ page }) => {
  const log = dialogs(page);
  await openApp(page);
  await open(page);
  await paintMode(page);
  await paintTwoClasses(page);
  await saved(page);
  const tiles = await tileKeysStored(page);
  await open(page, anotherRaster()); // the same grid, another file size: another raster
  expect(log).toEqual(["confirm: Close these labels? They stay saved in this browser."]);
  expect(await tileKeysStored(page)).toEqual([]);
  await open(page);
  await expect(message(page)).toHaveText("Labels restored.");
  expect(log).toHaveLength(2);
  expect(log[1]!.slice(9)).toMatch(restorePrompt);
  expect(await tileKeysStored(page)).toEqual(tiles);
});

test("a reload within 2 s of a stroke raises a beforeunload dialog; after Saved a reload raises none (criterion 9)", async ({ page }) => {
  const log = dialogs(page);
  await openApp(page);
  await open(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [12.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  await reload(page);
  expect(log).toEqual(["beforeunload: "]);
  await open(page);
  await expect(message(page)).toHaveText(/^(Raster opened\.|Labels restored\.)$/);
  await paintMode(page);
  await jumpTo(page, [15, 45], 6);
  await stroke(page, [a, { x: a.x + 40, y: a.y + 10 }]);
  await saved(page);
  log.length = 0;
  await reload(page);
  expect(log).toEqual([]);
});
