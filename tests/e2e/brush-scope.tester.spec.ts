import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { AefEntry } from "../../src/core/aef";
import { MESSAGES } from "../../src/ui/messages";
import { hoverFeatures, jumpTo, labels, message, openApp, openRaster, renameClass, rgbFixture, selectClass, stroke, tiff, toScreen } from "./helpers";

// Tester: spec 003 Local imagery (refused files keep the labels, AlphaEarth leaves them alone, the AOI
// tool switches to Pan), the paint queue when another raster opens, empty / single-class labels, and
// shortcuts in text fields.

const FIX = "tests/fixtures/aef";
const west = (JSON.parse(readFileSync(`${FIX}/aef-index/2021/32617.json`, "utf8")) as AefEntry[])[0]!;
const westFile = () => ({ name: "west.tiff", mimeType: "image/tiff", buffer: readFileSync(`${FIX}/cogs/${west.path}`) });
const other = () => tiff("other.tif", 300, 300, 3, (b, c, r) => (c + r + b) % 200, { epsg: 4326, gt: [12, 0.01, 0, 47, 0, -0.01] });

async function paintSome(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 7);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 80, y: c.y }]);
  const before = await labels(page);
  expect(before.size).toBeGreaterThan(0);
  return { c, before };
}
const dialogs = (page: Page) => { const seen: string[] = []; page.on("dialog", (d) => { seen.push(d.message()); void d.dismiss(); }); return seen; };

test.describe("refused or AlphaEarth files leave the labels (tester)", () => {
  test("Open GeoTIFF on an AlphaEarth file or a raster crossing 180 shows the refusal, asks nothing and keeps raster and labels", async ({ page }) => {
    const { before } = await paintSome(page);
    const seen = dialogs(page);
    await openRaster(page, westFile());
    await expect(message(page)).toHaveText(MESSAGES.rasterIsAef);
    await openRaster(page, tiff("x180.tif", 100, 50, 1, () => 1, { epsg: 4326, gt: [175, 0.1, 0, 10, 0, -0.1] }));
    await expect(message(page)).toHaveText(MESSAGES.rasterAntimeridian);
    expect(seen).toEqual([]);
    expect(await labels(page)).toEqual(before);
    await expect(page.locator("#raster-info")).toHaveText(/^rgb4326\.tif/);
    await expect(page.locator("#brush-panel")).toBeVisible();
  });

  test("opening an AlphaEarth file leaves the labels and the brush; Draw area switches the brush to Pan", async ({ page }) => {
    const { c, before } = await paintSome(page);
    const seen = dialogs(page);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    expect(seen).toEqual([]);
    expect(await labels(page)).toEqual(before);
    await expect(page.locator("#brush-panel")).toBeVisible();
    await page.click("#aef-draw");
    await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "false");
    await page.mouse.move(c.x, c.y + 60);
    expect(await hoverFeatures(page)).toHaveLength(0);
  });
});

test("another raster opened while mask reads are paused drops the queue: Train is enabled, the new store stays empty after the old read resumes, and painting reads the new raster", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.evaluate(() => {
    const s = (window as any).__geoapp.imagery();
    const read = s.readWindow.bind(s);
    const g = (window as any).__gate = { open: null as null | (() => void), reads: 0 };
    const wait = new Promise<void>((r) => { g.open = r; });
    s.readWindow = async (...a: unknown[]) => { g.reads++; await wait; return read(...a); };
  });
  await jumpTo(page, [15, 45], 7);
  const c = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y);
  await page.mouse.up();
  await expect(page.locator("#train")).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(1); // one at a time, still waiting
  const seen = dialogs(page); // no pixel is labelled yet, so no confirm
  await openRaster(page, other());
  await expect(message(page)).toHaveText("Raster opened.");
  expect(seen).toEqual([]);
  await expect(page.locator("#train")).toBeEnabled();
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

test.describe("empty and single-class labels (tester)", () => {
  test("Train with nothing painted, and after erasing one of two painted classes, says Paint at least two classes.", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await page.click("#train");
    await expect(message(page)).toHaveText(MESSAGES.paintTwo);
    await jumpTo(page, [15, 45], 6); // both points stay clear of the panel
    const a = await toScreen(page, [12.005, 45.005]), b = await toScreen(page, [18.005, 45.005]);
    await stroke(page, [a, { x: a.x + 40, y: a.y }]);
    await selectClass(page, 1);
    await stroke(page, [b, { x: b.x + 40, y: b.y }]);
    // the globe curves a screen line, so sweep a band of rows with the eraser
    for (const dy of [-6, -3, 0, 3, 6]) await stroke(page, [{ x: b.x - 30, y: b.y + dy }, { x: b.x + 80, y: b.y + dy }], "right");
    expect(new Set((await labels(page)).values())).toEqual(new Set([1]));
    await page.click("#train");
    await expect(message(page)).toHaveText(MESSAGES.paintTwo);
  });
});

test.describe("classes and shortcuts (tester)", () => {
  test("a padded duplicate name is refused, Add stays unique after renames, keys past the list do nothing, and model.classes follows the list", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await renameClass(page, 1, "  Class 1 ");
    await expect(message(page)).toHaveText(MESSAGES.className);
    await renameClass(page, 1, "Class 3");
    await page.click("#class-add");
    const names = () => page.locator("#classes .class-name").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(await names()).toEqual(["Class 1", "Class 3", "Class 4"]);
    await renameClass(page, 0, "  water ");
    expect(await names()).toEqual(["water", "Class 3", "Class 4"]);
    await page.locator("#map canvas").focus();
    await page.keyboard.press("2");
    await page.keyboard.press("9"); // only 3 classes
    expect(await page.locator("#classes li").evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"))).toBe(1);
    await jumpTo(page, [15, 45], 6); // both points stay clear of the panel
    const a = await toScreen(page, [12.005, 45.005]), b = await toScreen(page, [18.005, 45.005]);
    await stroke(page, [b, { x: b.x + 40, y: b.y }]); // Class 3
    await page.keyboard.press("1");
    await stroke(page, [a, { x: a.x + 40, y: a.y }]); // water
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 3 classes\.$/);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-model")]);
    const model = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(model.classes).toEqual(["water", "Class 3", "Class 4"]);
  });

  test("Space typed in a class name is a space, not Pan: the footprint stays and a drag still paints", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const field = page.locator("#classes .class-name").first();
    await field.click();
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
