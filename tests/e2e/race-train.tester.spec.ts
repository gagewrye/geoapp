import { expect, test } from "@playwright/test";
import { westFile } from "./aefTester";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, selectClass, toScreen } from "./helpers";
import { classifyBtn, exportHeld, gatedCalls, gateReads, geo, holdNextExport, info, lastExport, loadModel, openGate, openRgb, otherFixture, paintPair, rawStroke, releaseExport, savedModel, savePicker, trainBtn } from "./raceCombos";

// Tester pass 3 (F9-F11 and the Classify busy fix): Train, Classify, Load model, AlphaEarth and
// overlapping raster opens in combination, with cancel and failure paths.

test("Load model during a held Train: the last message describes the model in effect (the run's, which ends last)", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await openRgb(page);
  await paintPair(page, 0, 1);
  const n = (await labels(page)).size;
  await page.click("#train");
  await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
  const m1 = await savedModel(page);
  await paintPair(page, 1, 0); // swapped classes, so the next run's model differs
  await gateReads(page);
  await page.click("#train");
  await expect.poll(() => gatedCalls(page)).toBe(1);
  await loadModel(page, m1.text);
  await expect(message(page)).toHaveText("Loaded model with classes: Class 1, Class 2.");
  expect((await savedModel(page)).json).toEqual(m1.json);
  await openGate(page);
  await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
  expect((await savedModel(page)).json).not.toEqual(m1.json);
  expect(errors).toEqual([]);
});

test.describe("AlphaEarth state changes during a run (tester)", () => {
  test("opening an AlphaEarth file during a held export keeps Classify disabled until it ends; the file is the local raster's", async ({ page }) => {
    const errors = collectErrors(page);
    await savePicker(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const before = await labels(page);
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on/);
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    await expect(classifyBtn(page)).toBeDisabled();
    await expect(trainBtn(page)).toBeEnabled();
    await page.waitForTimeout(300);
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page);
    await expect(message(page)).toHaveText("Export complete.");
    await expect(classifyBtn(page)).toBeEnabled();
    const out = await geo(await lastExport(page));
    expect(out.size).toEqual([1000, 1000]);
    expect(out.origin).toEqual([10, 50]);
    expect(await labels(page)).toEqual(before); // AlphaEarth leaves the labels alone
    await expect(page.locator("#brush-panel")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("opening an AlphaEarth file during a held Train keeps Train disabled until it ends, and the run's model stands", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const n = (await labels(page)).size;
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    await expect(trainBtn(page)).toBeDisabled();
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    await expect(trainBtn(page)).toBeEnabled();
    expect((await savedModel(page)).json).toMatchObject({ classes: ["Class 1", "Class 2"] });
    expect(errors).toEqual([]);
  });
});

test.describe("Train and opens that don't replace the raster (tester)", () => {
  test("an Open raster refused as AlphaEarth during a held Train: the run is not dropped", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const n = (await labels(page)).size;
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    await openRaster(page, westFile());
    await expect(message(page)).toHaveText("This is an AlphaEarth file. Use Open AlphaEarth file.");
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    await expect(trainBtn(page)).toBeEnabled();
    expect((await savedModel(page)).json).toMatchObject({ classes: ["Class 1", "Class 2"] });
    expect(errors).toEqual([]);
  });

  test("an open cancelled at Discard labels? during a held Train: the run is not dropped and the labels stay", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const before = await labels(page);
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.dismiss(); });
    await openRaster(page, otherFixture());
    await expect.poll(() => asked).toBe(1);
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${before.size} pixels, 2 classes.`);
    expect(await labels(page)).toEqual(before);
    await expect(info(page)).toHaveText(/^rgb4326\.tif: 1000 x 1000/);
    expect(errors).toEqual([]);
  });

  test("a Train that fails after another raster opened: no error, and Train stays disabled on the new raster until the old run ends, then trains the new labels", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    page.once("dialog", (d) => d.accept());
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    // label other.tif: class 1 west of 34E, class 2 east (its reads aren't gated)
    await jumpTo(page, [34, 43], 6);
    const a = await toScreen(page, [31.005, 43.005]), b = await toScreen(page, [36.005, 43.005]);
    await selectClass(page, 0);
    await rawStroke(page, [a, { x: a.x + 40, y: a.y }]);
    await selectClass(page, 1);
    await rawStroke(page, [b, { x: b.x + 40, y: b.y }]);
    await page.waitForTimeout(500);
    await expect(trainBtn(page)).toBeDisabled(); // the old run still holds the one snapshot
    await openGate(page, true);
    await expect(trainBtn(page)).toBeEnabled();
    await expect(message(page)).toHaveText("Raster opened.");
    const n = (await labels(page)).size;
    expect(n).toBeGreaterThan(0);
    await page.click("#train");
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    expect(errors).toEqual([]);
  });
});
