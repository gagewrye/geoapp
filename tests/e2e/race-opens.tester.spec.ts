import { expect, test } from "@playwright/test";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, selectClass, stroke, toScreen } from "./helpers";
import { fileGate, fileWaiting, holdFile, info, otherFixture, releaseFiles } from "./raceCombos";

// Tester pass 3 (F9-F11): overlapping raster opens with labels, with cancel paths.

test.describe("overlapping opens with labels (tester)", () => {
  test("an older open released after a newer one opened and was labelled: no confirm, labels and raster unchanged", async ({ page }) => {
    const errors = collectErrors(page);
    await fileGate(page);
    await openApp(page);
    await holdFile(page, "slow.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(0);
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await jumpTo(page, [34, 43], 6);
    const a = await toScreen(page, [31.005, 43.005]), b = await toScreen(page, [36.005, 43.005]);
    await selectClass(page, 0);
    await stroke(page, [a, { x: a.x + 40, y: a.y }]);
    await selectClass(page, 1);
    await stroke(page, [b, { x: b.x + 40, y: b.y }]);
    const before = await labels(page);
    expect(before.size).toBeGreaterThan(0);
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.dismiss(); });
    await releaseFiles(page);
    await page.waitForTimeout(800);
    expect(asked).toBe(0);
    expect(await labels(page)).toEqual(before);
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    expect(errors).toEqual([]);
  });
});
