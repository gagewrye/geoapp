import { expect, test } from "@playwright/test";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, rgbFixture, selectClass, stroke, toScreen } from "./helpers";
import { fileGate, fileWaiting, holdFile, info, openRgb, otherFixture, paintPair, releaseFiles } from "./raceCombos";

// Tester pass 3 (F9-F11 and the Classify busy fix): Train, Classify, Load model, AlphaEarth and
// overlapping raster opens in combination, with cancel and failure paths.

test.describe("overlapping opens with labels (tester)", () => {
  test("an older open released after a newer one opened and was labelled: no confirm, labels, raster and Train unchanged", async ({ page }) => {
    const errors = collectErrors(page);
    await fileGate(page);
    await openApp(page);
    await holdFile(page, "slow.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(0);
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
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
    await page.click("#train");
    await expect(message(page)).toHaveText(`Trained on ${before.size} pixels, 2 classes.`);
    expect(errors).toEqual([]);
  });

  test("a newer open cancelled at Discard labels? while the older one builds its preview: the older raster, its labels and its preview stay", async ({ page }) => {
    const errors = collectErrors(page);
    await fileGate(page);
    await openApp(page);
    await holdFile(page, "slow.tif", "committed");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(0);
    // mask reads of slow.tif are held too, so label through the hook (off nodata: the fixture has none)
    await page.evaluate(() => {
      const { store } = (window as any).__geoapp.labels;
      const t = new Uint8Array(256 * 256);
      t.fill(1, 0, 100);
      t.fill(2, 1000, 1100);
      store.tiles.set("0,0", t);
    });
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.dismiss(); });
    await openRaster(page, otherFixture());
    await expect.poll(() => asked).toBe(1);
    await releaseFiles(page);
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getSource("preview")?.coordinates[0][0] as number)).toBeCloseTo(10, 6);
    expect((await labels(page)).size).toBe(200);
    await page.click("#train");
    await expect(message(page)).toHaveText("Trained on 200 pixels, 2 classes.");
    expect(errors).toEqual([]);
  });

  test("two opens both held at the header, released newest first then oldest: the newest stands with one confirm", async ({ page }) => {
    const errors = collectErrors(page);
    await fileGate(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await holdFile(page, "a.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "a.tif" });
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(0);
    const heldA = await fileWaiting(page);
    await holdFile(page, "other.tif", "all");
    await openRaster(page, otherFixture());
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(heldA);
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.accept(); });
    // release other.tif only (it was queued after a.tif)
    await page.evaluate((k) => {
      const g = (window as any).__files;
      g.hold.delete("other.tif");
      for (const go of g.waiting.splice(k)) go();
    }, heldA);
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    await expect(message(page)).toHaveText("Raster opened.");
    await releaseFiles(page);
    await page.waitForTimeout(800);
    expect(asked).toBe(1);
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    expect(await page.evaluate(() => (window as any).__geoapp.imagery().meta.width)).toBe(800);
    expect((await labels(page)).size).toBe(0);
    await expect(message(page)).toHaveText("Raster opened.");
    expect(errors).toEqual([]);
  });
});
