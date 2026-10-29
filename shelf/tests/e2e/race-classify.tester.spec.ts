import { expect, test } from "@playwright/test";
import { collectErrors, message, openApp, openRaster } from "./helpers";
import { classifyBtn, exportHeld, exportNow, geo, holdNextExport, lastExport, loadModel, openRgb, otherFixture, paintPair, releaseExport, savedModel, savePicker, trainBtn } from "./raceCombos";

// Tester pass 3 (F9-F11 and the Classify busy fix): Train, Classify, Load model, AlphaEarth and
// overlapping raster opens in combination, with cancel and failure paths.

test.describe("Classify uses the model at the click (tester)", () => {
  test("Load model and Train during a held export: the file is the click's model; afterwards the newer model is in effect", async ({ page }) => {
    const errors = collectErrors(page);
    await savePicker(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
    const m1 = await savedModel(page);
    const e1 = await exportNow(page);
    await paintPair(page, 1, 0); // the same footprints with the classes swapped
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
    const m2 = await savedModel(page);
    const e2 = await exportNow(page);
    expect(e2).not.toBe(e1);

    // export with m2 held; Load model m1 meanwhile
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    await expect(classifyBtn(page)).toBeDisabled();
    await loadModel(page, m1.text);
    await expect(message(page)).toHaveText("Loaded model with classes: Class 1, Class 2.");
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page);
    await expect(message(page)).toHaveText("Export complete.");
    expect(await lastExport(page)).toBe(e2);
    await expect(classifyBtn(page)).toBeEnabled();
    expect((await savedModel(page)).json).toEqual(m1.json);
    expect(await exportNow(page)).toBe(e1);

    // export with m1 held; Train (labels are swapped, so m2) meanwhile
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    await expect(trainBtn(page)).toBeEnabled(); // Classify doesn't block Train
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page);
    await expect(message(page)).toHaveText("Export complete.");
    expect(await lastExport(page)).toBe(e1);
    expect((await savedModel(page)).json).toEqual(m2.json);
    expect(errors).toEqual([]);
  });

  test("a write failure after another raster opened: the error shows, Classify is enabled again, and a retry exports the new raster", async ({ page }) => {
    const errors = collectErrors(page);
    await savePicker(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on/);
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    page.once("dialog", (d) => d.accept());
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page, true);
    await expect(message(page)).toHaveText("simulated write failure");
    await expect(classifyBtn(page)).toBeEnabled();
    const out = await geo(await exportNow(page)); // the model (3 bands) still fits other.tif
    expect(out.size).toEqual([800, 600]);
    expect(out.origin).toEqual([30, 46]);
    expect(errors).toEqual([]);
  });
});
