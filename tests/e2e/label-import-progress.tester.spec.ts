import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { writeFile } from "../unit/helpers/labelFiles";
import { collectErrors, jumpTo, message, openApp, openRaster, paintMode, path, RGB_GRID, rgbFixture, stroke, tileKeysStored, toScreen } from "./helpers";
import { at, classList, effectiveTiles, importFile, maskFile, upload } from "./seeding";

// Spec 021, tester: Cancel in pass 2, a second import after a Cancel, and restored labels under view settings changed mid-run.

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const GEOG = { GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 };
/** On rgbFixture's grid, no class table: 16 windows per pass, two passes, one file read per window per pass. */
function other() {
  const v = new Uint8Array(1000 * 1000);
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 1000; c++) v[r * 1000 + c] = 1 + (((c >> 6) + (r >> 6)) % 2);
  return upload("other.tif", writeFile(RGB_GRID, 1, v, "0", GEOG));
}

/** Holds file read k until allow(k); window.__step.log lists every file read. */
const stepReads = (page: Page) => page.evaluate(() => {
  const g = (window as any).__step = { allowed: 0, log: [] as string[] };
  (window as any).__geoapp.labelFile = (f: { read: (w: { x0: number; y0: number }) => Promise<Uint8Array> }) => {
    const read = f.read.bind(f);
    f.read = async (w) => {
      const k = g.log.push(`${w.x0},${w.y0}`);
      while (k > g.allowed) await new Promise((r) => setTimeout(r, 5));
      return read(w);
    };
  };
});
const allow = (page: Page, n: number) => page.evaluate((n) => { (window as any).__step.allowed = n; }, n);
const reads = (page: Page): Promise<number> => page.evaluate(() => (window as any).__step.log.length);
const bar = (page: Page) => page.locator("#import-progress");
const barValue = (page: Page) => page.evaluate(() => document.getElementById("import-progress")!.getAttribute("value"));
const labelLayers = (page: Page): Promise<string[]> => page.evaluate(() =>
  ((window as any).__geoapp.map.getLayersOrder() as string[]).filter((id) => id.startsWith("label-") || id === "mask").sort());
const views = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  return (map.getLayersOrder() as string[]).filter((id) => id.startsWith("label-") || id === "mask")
    .map((id) => [map.getPaintProperty(id, "raster-opacity"), map.getLayoutProperty(id, "visibility") ?? "visible"].join(" "));
});

async function withLabels(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(seeded);
  await paintMode(page);
  await jumpTo(page, at(256, 256), 10);
  await stroke(page, path(await toScreen(page, at(250.5, 256.5)), await toScreen(page, at(262.5, 256.5)), 8));
  await expect.poll(() => labelLayers(page)).toContain("mask");
  expect((await labelLayers(page)).some((id) => id.startsWith("label-"))).toBe(true);
}
const snapshot = async (page: Page) => ({ tiles: await effectiveTiles(page), classes: await classList(page), keys: await tileKeysStored(page), layers: await labelLayers(page), undo: await page.locator("#undo").isEnabled() });
async function expectRestored(page: Page, before: Awaited<ReturnType<typeof snapshot>>) {
  await expect.poll(() => labelLayers(page)).toEqual(before.layers);
  const after = await snapshot(page);
  expect(after.keys).toEqual(before.keys);
  expect([...after.tiles.keys()]).toEqual([...before.tiles.keys()]);
  for (const [k, t] of before.tiles) expect(Buffer.from(after.tiles.get(k)!).equals(Buffer.from(t)), k).toBe(true);
  expect(after.classes).toEqual(before.classes);
  expect(after.undo).toBe(before.undo);
}
async function startImport(page: Page) {
  await stepReads(page);
  page.once("dialog", (d) => void d.accept());
  await importFile(page, other());
  await expect(bar(page)).toBeVisible();
}

test("Cancel in pass 2 restores everything and reads no window past k + 1; the next import starts indeterminate, isn't pre-cancelled, and succeeds (criteria 2, 5)", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await withLabels(page);
  const before = await snapshot(page);
  await startImport(page);
  await allow(page, 20); // pass 1 is reads 1-16, so this is window 4 of pass 2
  await expect.poll(() => barValue(page)).toBe("20");
  await page.click("#import-cancel");
  await allow(page, 1000);
  await expect(message(page)).toHaveText(MESSAGES.importCancelled);
  await expect(bar(page)).toBeHidden();
  await expect(page.locator("#import-cancel")).toBeHidden();
  expect(await reads(page)).toBeLessThanOrEqual(21);
  await expectRestored(page, before);
  // a second import: indeterminate until a window is done, and runs to the end
  await startImport(page);
  expect(await barValue(page)).toBeNull();
  await expect(page.locator("#import-cancel")).toBeVisible();
  await allow(page, 1000);
  await expect(message(page)).toHaveText(seeded);
  await expect.poll(() => labelLayers(page)).toEqual(["mask"]);
  expect(errors).toEqual([]);
});

test("labels restored by Cancel take the Opacity and Show labels set during the run (criteria 3, 8)", async ({ page }) => {
  test.setTimeout(120_000);
  await withLabels(page);
  const before = await snapshot(page);
  await startImport(page);
  await page.locator("#label-opacity").fill("30");
  await page.click("#show-labels"); // hidden
  expect(await labelLayers(page)).toEqual([]);
  await allow(page, 2);
  await page.click("#import-cancel");
  await allow(page, 1000);
  await expect(message(page)).toHaveText(MESSAGES.importCancelled);
  await expectRestored(page, before);
  expect(new Set(await views(page))).toEqual(new Set(["0.3 none"]));
  await page.click("#show-labels");
  expect(new Set(await views(page))).toEqual(new Set(["0.3 visible"]));
});
