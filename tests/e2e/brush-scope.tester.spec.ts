import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { editName, hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, renameClass, rgbFixture, stroke, tiff, toScreen } from "./helpers";

import { holdMasks } from "./seeding";
// Tester: spec 003 Local imagery (refused files keep the labels), the paint queue when another raster
// opens, and shortcuts in text fields.

const other = () => tiff("other.tif", 300, 300, 3, (b, c, r) => (c + r + b) % 200, { epsg: 4326, gt: [12, 0.01, 0, 47, 0, -0.01] });

async function paintSome(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 7);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 80, y: c.y }]);
  const before = await labels(page);
  expect(before.size).toBeGreaterThan(0);
  return { c, before };
}
const dialogs = (page: Page) => { const seen: string[] = []; page.on("dialog", (d) => { seen.push(d.message()); void d.dismiss(); }); return seen; };

test.describe("refused files leave the labels (tester)", () => {
  test("Open GeoTIFF on a raster crossing 180 shows the refusal, asks nothing and keeps raster and labels", async ({ page }) => {
    const { before } = await paintSome(page);
    const seen = dialogs(page);
    await openRaster(page, tiff("x180.tif", 100, 50, 1, () => 1, { epsg: 4326, gt: [175, 0.1, 0, 10, 0, -0.1] }));
    await expect(message(page)).toHaveText(MESSAGES.rasterAntimeridian);
    expect(seen).toEqual([]);
    expect(await labels(page)).toEqual(before);
    await expect(page.locator("#raster-info")).toHaveText(/^rgb4326\.tif/);
    await expect(page.locator("#brush-panel")).toBeVisible();
  });
});

test("another raster opened while mask reads are paused drops the queue: Import labels is enabled, the new store stays empty after the old read resumes, and painting reads the new raster", async ({ page }) => {
  await openApp(page);
  await holdMasks(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  // the view first, and its imagery tiles read, so the gate counts only the stroke's mask read (how many tiles a view
  // reads depends on the map's size, which spec 032's status bar changed)
  await jumpTo(page, [15, 45], 7);
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const s = (window as any).__geoapp.imagery();
    const g = (window as any).__gate = { open: null as null | (() => void), reads: 0 };
    const wait = new Promise<void>((r) => { g.open = r; });
    for (const m of ["readWindow", "readSamples"]) {
      if (!s[m]) continue;
      const read = s[m].bind(s);
      s[m] = async (...a: unknown[]) => { g.reads++; await wait; return read(...a); };
    }
  });
  const c = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y);
  await page.mouse.up();
  await expect(page.locator("#import-labels")).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(1); // one at a time, still waiting
  const seen = dialogs(page); // no pixel is labelled yet, so no confirm
  await openRaster(page, other());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  expect(seen).toEqual([]);
  await expect(page.locator("#import-labels")).toBeEnabled();
  await page.evaluate(() => (window as any).__gate.open());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => { const s = (window as any).__geoapp.labels.store; return [s.width, s.tiles.size]; })).toEqual([300, 0]);
  expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await jumpTo(page, [13.5, 45.5], 8);
  const d = await toScreen(page, [13.505, 45.505]);
  await stroke(page, [d, { x: d.x + 30, y: d.y }]);
  expect((await labels(page)).size).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(1); // the new source, not the paused one
});

test.describe("classes and shortcuts (tester)", () => {
  test("a padded duplicate name is refused, Add stays unique after renames, keys past the list do nothing", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await renameClass(page, 1, "  Class 1 ");
    await expect(message(page)).toHaveText(MESSAGES.className);
    await renameClass(page, 1, "Class 3");
    await page.click("#class-add");
    const names = () => page.locator("#classes .class-name").evaluateAll((els) => els.map((e) => e.textContent));
    expect(await names()).toEqual(["Class 1", "Class 3", "Class 4"]);
    await renameClass(page, 0, "  water ");
    expect(await names()).toEqual(["water", "Class 3", "Class 4"]);
    await page.locator("#map canvas").focus();
    await page.keyboard.press("2");
    await page.keyboard.press("9"); // only 3 classes
    expect(await page.locator("#classes li").evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"))).toBe(1);
  });

  test("Space typed in a class name is a space, not Pan: the footprint stays and a drag still paints", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await jumpTo(page, [15, 45], 7);
    const field = await editName(page, 0);
    await field.press("End");
    await page.keyboard.down("Space");
    await expect(field).toHaveValue("Class 1 ");
    const c = await toScreen(page, [15.005, 45.005]);
    await page.mouse.move(c.x, c.y);
    await page.mouse.move(c.x + 2, c.y);
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
    await stroke(page, [c, { x: c.x + 50, y: c.y }]);
    await page.keyboard.up("Space");
    expect((await labels(page)).size).toBeGreaterThan(0);
  });
});
