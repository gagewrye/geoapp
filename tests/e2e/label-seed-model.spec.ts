import { expect, test, type Page } from "@playwright/test";
import { paletteColour } from "../../src/core/classes";
import { tileWindows } from "../../src/core/grid";
import { seedFromModel } from "../../src/core/predict";
import { maskNodata } from "../../src/core/seed";
import type { Model } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, labels, message, openApp, openRaster, path, rgbFixture, selectClass, stroke, toScreen } from "./helpers";
import { classList, sourceOf, storeTiles } from "./seeding";

// Spec 004 criterion 17, on spec 001's EPSG:4326 fixture (rgbFixture).

/**
 * Two classes on the west half (band 1 constant), at rows whose band 2 (100 + row % 100) differs:
 * class 1 near row 415, class 2 near row 485, so the model's confidence varies with the row.
 */
async function paintAndTrain(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(page.locator("#seed-model")).toBeDisabled(); // no model yet
  await jumpTo(page, [13, 45.5], 6);
  for (const [i, lat] of [[0, 45.845], [1, 45.145]] as const) {
    await selectClass(page, i);
    await stroke(page, path(await toScreen(page, [12.005, lat]), await toScreen(page, [14.005, lat]), 8));
  }
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
  await expect(page.locator("#seed-model")).toBeEnabled();
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__geoapp.model())) as Model);
}

/** seedFromModel then maskNodata on every window, from the fixture in Node; zeros where nothing is stored. */
async function expectSeeded(page: Page, model: Model, minProb: number, keep?: Map<string, number>): Promise<number> {
  const src = await sourceOf(rgbFixture());
  const tiles = await storeTiles(page);
  let bad = 0, labelled = 0;
  for (const w of tileWindows(1000, 1000)) {
    const tile = await src.readWindow(w.x0, w.y0, w.width, w.height);
    const want = seedFromModel(model, tile, minProb, [1, 2]);
    maskNodata(tile, want);
    const got = tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height);
    got.forEach((v, i) => {
      const p = keep?.get(`${w.x0 + (i % w.width)},${w.y0 + Math.floor(i / w.width)}`);
      if (v !== (p ?? want[i])) bad++;
      if (v) labelled++;
    });
  }
  expect(bad).toBe(0);
  return labelled;
}

test("a Replace seed at 0 gives seedFromModel then maskNodata on every window, and the list is model.classes", async ({ page }) => {
  test.setTimeout(120_000);
  const model = await paintAndTrain(page);
  await page.locator("#classes .class-name").first().fill("renamed"); // Replace drops the old list
  await page.locator("#classes .class-name").first().press("Enter");
  await page.selectOption("#seed-mode", "replace");
  page.once("dialog", (d) => void d.accept());
  await page.click("#seed-model");
  await expect(message(page)).toHaveText(/^Seeded \d+ pixels in 2 classes\.$/);
  expect(await expectSeeded(page, model, 0)).toBe(1000 * 1000);
  expect(await classList(page)).toEqual(model.classes.map((name, i) => ({ name, colour: paletteColour(i) })));
});

test("a Merge seed keeps the painted pixels and the list", async ({ page }) => {
  test.setTimeout(120_000);
  const model = await paintAndTrain(page);
  const painted = await labels(page);
  const list = await classList(page);
  await page.click("#seed-model");
  await expect(message(page)).toHaveText(`Seeded ${1000 * 1000 - painted.size} pixels in 2 classes.`);
  await expectSeeded(page, model, 0, painted);
  expect(await classList(page)).toEqual(list);
});

test("at 0.9 only pixels whose max softmax is at least 0.9 are labelled; 1.5 shows the message and disables Seed", async ({ page }) => {
  test.setTimeout(120_000);
  const model = await paintAndTrain(page);
  await page.locator("#min-confidence").fill("0.9");
  await page.selectOption("#seed-mode", "replace");
  page.once("dialog", (d) => void d.accept());
  await page.click("#seed-model");
  await expect(message(page)).toHaveText(/^Seeded \d+ pixels in \d classes\.$/);
  const n = await expectSeeded(page, model, 0.9);
  // the threshold matters here: some pixels are below 0.9
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(1000 * 1000);
  await page.locator("#min-confidence").fill("1.5");
  await expect(message(page)).toHaveText(MESSAGES.minConfidence);
  await expect(page.locator("#seed-model")).toBeDisabled();
  await page.locator("#min-confidence").fill("0.5");
  await expect(page.locator("#seed-model")).toBeEnabled();
  await expect(message(page)).toHaveText("");
});

test("a loaded model whose class names spec 003 refuses seeds nothing and says why", async ({ page }) => {
  test.setTimeout(120_000);
  const model = await paintAndTrain(page);
  const painted = await labels(page);
  const list = await classList(page);
  const bad = JSON.stringify({ ...model, classes: [" padded ", "b"] });
  await page.setInputFiles("#load-model", { name: "model.json", mimeType: "application/json", buffer: Buffer.from(bad) });
  await expect(message(page)).toHaveText(/^Loaded model/);
  await page.click("#seed-model"); // Merge: no confirm
  await expect(message(page)).toHaveText(MESSAGES.modelNames);
  expect(await labels(page)).toEqual(painted);
  expect(await classList(page)).toEqual(list);
  await expect(page.locator("#seed-model")).toBeEnabled();
});
