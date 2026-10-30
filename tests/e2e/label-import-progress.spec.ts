import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "../unit/helpers/labelFiles";
import { MESSAGES } from "../../src/ui/messages";
import { rgbClassFile } from "../unit/helpers/labelFiles";
import { collectErrors, jumpTo, message, openApp, openRaster, paintMode, path, RGB_GRID, rgbFixture, stroke, tileKeysStored, toScreen } from "./helpers";
import { at, classList, effectiveTiles, importFile, maskFile, upload } from "./seeding";

// Spec 021 criteria 2-8: the import's bar and Cancel, the old labels off the map while it runs, and restores.

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const GEOG = { GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 };
/** A label file on rgbFixture's grid, f per pixel, GDAL_NODATA 0, no class table: 16 windows, one pass (spec 024), one file read per window. */
function sameGrid(name: string, f: (c: number, r: number) => number) {
  const v = new Uint8Array(1000 * 1000);
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 1000; c++) v[r * 1000 + c] = f(c, r);
  return upload(name, writeFile(RGB_GRID, 1, v, "0", GEOG));
}
const other = () => sameGrid("other.tif", (c, r) => 1 + (((c >> 6) + (r >> 6)) % 2));
const empty = () => sameGrid("empty.tif", () => 0);

/** Holds read k of every later label file until allow(k) (window.__step.log lists the windows read); read failAt throws. */
const stepReads = (page: Page, failAt = 0) => page.evaluate((failAt) => {
  const g = (window as any).__step = { allowed: 0, log: [] as string[] };
  (window as any).__geoapp.labelFile = (f: { read: (w: { x0: number; y0: number }) => Promise<Uint8Array> }) => {
    const read = f.read.bind(f);
    f.read = async (w) => {
      const k = g.log.push(`${w.x0},${w.y0}`);
      while (k > g.allowed) await new Promise((r) => setTimeout(r, 5));
      if (k === failAt) throw new Error("Test read failure.");
      return read(w);
    };
  };
}, failAt);
const allow = (page: Page, n: number) => page.evaluate((n) => { (window as any).__step.allowed = n; }, n);
const readsLogged = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as any).__step.log]);

const bar = (page: Page) => page.locator("#import-progress");
const cancel = (page: Page) => page.locator("#import-cancel");
const labelLayers = (page: Page): Promise<string[]> => page.evaluate(() =>
  ((window as any).__geoapp.map.getLayersOrder() as string[]).filter((id) => id.startsWith("label-") || id === "mask").sort());
const barValue = (page: Page) => page.evaluate(() => (document.getElementById("import-progress") as HTMLProgressElement).getAttribute("value"));

/** rgbFixture with a mask import and one painted stroke: a mask layer, label- overlays and Undo enabled. */
async function withLabels(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(seeded);
  await paintMode(page);
  await jumpTo(page, at(256, 256), 10);
  await stroke(page, path(await toScreen(page, at(250.5, 256.5)), await toScreen(page, at(262.5, 256.5)), 8));
  expect((await tileKeysStored(page)).length).toBeGreaterThan(0);
  await expect.poll(() => labelLayers(page)).toContain("mask");
  expect((await labelLayers(page)).some((id) => id.startsWith("label-"))).toBe(true);
  await expect(page.locator("#undo")).toBeEnabled();
}

/** What a restore must give back: every tile(key), the class list, the label layers and Undo's state. */
async function snapshot(page: Page) {
  return { tiles: await effectiveTiles(page), classes: await classList(page), layers: await labelLayers(page), undo: await page.locator("#undo").isEnabled() };
}
async function expectRestored(page: Page, before: Awaited<ReturnType<typeof snapshot>>) {
  await expect.poll(() => labelLayers(page)).toEqual(before.layers);
  const after = await snapshot(page);
  expect([...after.tiles.keys()]).toEqual([...before.tiles.keys()]);
  for (const [k, t] of before.tiles) expect(Buffer.from(after.tiles.get(k)!).equals(Buffer.from(t)), k).toBe(true);
  expect(after.classes).toEqual(before.classes);
  expect(after.undo).toBe(before.undo);
}

/** Starts a stepped import of `file`, accepting "Replace labels?". */
async function startImport(page: Page, file: ReturnType<typeof upload>, failAt = 0) {
  await stepReads(page, failAt);
  page.once("dialog", (d) => { expect(d.message()).toBe(MESSAGES.replace); void d.accept(); });
  await importFile(page, file);
}

test("the bar counts windows, Cancel shows, the old labels leave the map; Cancel at window k restores everything (criteria 2, 3, 5)", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await withLabels(page);
  const before = await snapshot(page);
  await startImport(page, other());
  await expect(bar(page)).toBeVisible();
  expect(await labelLayers(page)).toEqual([]);
  // Show labels off and on brings nothing back
  await page.click("#show-labels");
  await page.click("#show-labels");
  expect(await labelLayers(page)).toEqual([]);
  await allow(page, 3);
  await expect.poll(() => barValue(page)).toBe("3");
  expect(await bar(page).evaluate((b: HTMLProgressElement) => b.max)).toBe(16); // one pass (spec 024)
  await expect(cancel(page)).toBeVisible();
  await expect(message(page)).toHaveText("Importing labels…");
  await page.click("#import-cancel");
  await allow(page, 1000);
  await expect(message(page)).toHaveText(MESSAGES.importCancelled);
  await expect(bar(page)).toBeHidden();
  await expect(cancel(page)).toBeHidden();
  expect((await readsLogged(page)).length).toBeLessThanOrEqual(4); // window k + 1 at most
  await expectRestored(page, before);
  expect(errors).toEqual([]);
});

test("Cancel while a read is in flight, then that read failing, restores and says the import was cancelled (criterion 5)", async ({ page }) => {
  test.setTimeout(120_000);
  await withLabels(page);
  const before = await snapshot(page);
  await startImport(page, other(), 4);
  await allow(page, 3);
  await expect.poll(() => barValue(page)).toBe("3");
  await page.click("#import-cancel");
  await allow(page, 1000); // read 4, in flight at the click, now rejects
  await expect(message(page)).toHaveText(MESSAGES.importCancelled);
  await expect(bar(page)).toBeHidden();
  expect(await readsLogged(page)).toHaveLength(4);
  await expectRestored(page, before);
});

test("on success only the new mask layer exists, and the bar and Cancel hide after the message (criteria 2, 3)", async ({ page }) => {
  test.setTimeout(120_000);
  await withLabels(page);
  await startImport(page, other());
  await expect(bar(page)).toBeVisible();
  expect(await labelLayers(page)).toEqual([]);
  await allow(page, 1000);
  await expect(message(page)).toHaveText(seeded);
  await expect(bar(page)).toBeHidden();
  await expect(cancel(page)).toBeHidden();
  await expect.poll(() => labelLayers(page)).toEqual(["mask"]);
  expect(await tileKeysStored(page)).toEqual([]);
  await expect(page.locator("#undo")).toBeDisabled();
});

test("a refused file after OK keeps the old labels, their layers and Undo, and the bar never shows (criterion 4)", async ({ page }) => {
  await withLabels(page);
  const before = await snapshot(page);
  await page.evaluate(() => {
    const b = document.getElementById("import-progress")!;
    (window as any).__barShown = false;
    new MutationObserver(() => { if (!b.hidden) (window as any).__barShown = true; }).observe(b, { attributes: true });
  });
  await startImport(page, upload("rgb.tif", rgbClassFile()));
  await expect(message(page)).toHaveText(MESSAGES.labelFile);
  await expectRestored(page, before);
  expect(await page.evaluate(() => (window as any).__barShown)).toBe(false);
});

test("a read failure partway and an empty import restore the old labels, with their usual messages (criterion 6)", async ({ page }) => {
  test.setTimeout(120_000);
  await withLabels(page);
  const before = await snapshot(page);
  await startImport(page, other(), 3);
  await allow(page, 1000);
  await expect(message(page)).toHaveText("Test read failure.");
  await expect(bar(page)).toBeHidden();
  await expectRestored(page, before);
  await startImport(page, empty());
  await allow(page, 1000);
  await expect(message(page)).toHaveText(MESSAGES.noSeed);
  await expect(bar(page)).toBeHidden();
  await expectRestored(page, before);
});

test("opening a raster during an import asks to discard: OK leaves no labels, bar or message; Cancel lets it finish (criterion 7)", async ({ page }) => {
  test.setTimeout(120_000);
  await withLabels(page);
  await startImport(page, other());
  await allow(page, 2);
  await expect.poll(() => barValue(page)).toBe("2");
  // Cancel on the discard confirm: the import goes on
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); void d.dismiss(); });
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect.poll(() => asked).toBe(MESSAGES.discard);
  await expect(bar(page)).toBeVisible(); // the open clears #message as it starts (spec 019), so the bar shows the run goes on
  await expect(cancel(page)).toBeVisible();
  await allow(page, 1000);
  await expect(message(page)).toHaveText(seeded);
  // OK on the discard confirm: the import ends with no message
  await startImport(page, other());
  await allow(page, 2);
  await expect.poll(() => barValue(page)).toBe("2");
  page.once("dialog", (d) => { asked = d.message(); void d.accept(); });
  await openRaster(page, { ...rgbFixture(), name: "third.tif" });
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(bar(page)).toBeHidden();
  await expect(cancel(page)).toBeHidden();
  await allow(page, 1000);
  await page.waitForTimeout(500);
  await expect(message(page)).toHaveText("Raster opened.");
  expect(await tileKeysStored(page)).toEqual([]);
  expect(await labelLayers(page)).toEqual([]);
  expect((await effectiveTiles(page)).size).toBe(0);
});

test("during an import edits are disabled or ignored, and Opacity and Show labels still apply (criterion 8)", async ({ page }) => {
  test.setTimeout(120_000);
  await withLabels(page);
  const keys = await tileKeysStored(page);
  const classes = await classList(page);
  await startImport(page, other());
  await expect(bar(page)).toBeVisible();
  // a Paint stroke is ignored
  await page.click("#mode-paint");
  const a = await toScreen(page, at(700.5, 700.5));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 10);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await tileKeysStored(page)).toEqual(keys);
  for (const id of ["#undo", "#import-labels", "#class-map", "#export-labels", "#class-add"]) await expect(page.locator(id)).toBeDisabled();
  await expect(page.locator("#classes .class-name").first()).toBeDisabled();
  await page.keyboard.press("Control+z");
  expect(await tileKeysStored(page)).toEqual(keys);
  expect(await classList(page)).toEqual(classes);
  // the view controls work, and apply to the layers drawn after the import
  await page.locator("#label-opacity").fill("30");
  await expect(page.locator("#label-opacity-text")).toHaveText("Opacity: 30%");
  await page.click("#show-labels");
  await allow(page, 1000);
  await expect(message(page)).toHaveText(seeded);
  await expect.poll(() => labelLayers(page)).toEqual(["mask"]);
  const view = await page.evaluate(() => {
    const { map } = (window as any).__geoapp;
    return [map.getPaintProperty("mask", "raster-opacity"), map.getLayoutProperty("mask", "visibility")];
  });
  expect(view).toEqual([0.3, "none"]);
});
