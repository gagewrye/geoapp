import { expect, test, type Page } from "@playwright/test";
import { anotherRaster, jumpTo, labelCount, message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture, settled, toScreen } from "./helpers";
import { effectiveTiles, labelled, tileDiff } from "./seeding";

// Spec 010: undo of paint strokes (button and Ctrl+Z). The brush cursor test went with spec 073.
const undoButton = (page: Page) => page.locator("#undo");
/** The effective labels, by tile (spec 072: compared with tileDiff, not through labels()). */
const snapshot = (page: Page) => effectiveTiles(page);
const pixels = (tiles: Map<string, Uint8Array>) => [...labelled(tiles, 1000)];

async function setup(page: Page) {
  await openApp(page);
  await page.evaluate(() => { (window as any).__geoapp.pauseMasks = true; }); // spec 023: strokes, not the background, read the masks
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
}

test("Undo is disabled while a stroke's cells wait for masks; then one Undo removes the whole stroke (criterion 4)", async ({ page }) => {
  await setup(page);
  const empty = await snapshot(page);
  await page.evaluate(() => {
    const s = (window as any).__geoapp.imagery();
    const g = (window as any).__gate = { held: true, reads: 0, open: null as null | (() => void), wait: null as null | Promise<void> };
    g.wait = new Promise<void>((r) => { g.open = r; });
    // spec 023: masks are read through readSamples, by band; the setup paused the background reads
    for (const m of ["readWindow", "readSamples"]) {
      const read = s[m].bind(s);
      s[m] = async (...a: unknown[]) => { if (g.held) { g.reads++; await g.wait; } return read(...a); };
    }
  });
  const c = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y);
  await expect(undoButton(page)).toBeDisabled(); // during the stroke
  await page.mouse.move(c.x + 300, c.y + 200); // into more tiles
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBeGreaterThan(0); // its cells wait on held reads
  await expect(undoButton(page)).toBeDisabled(); // after it, cells still waiting
  expect(await labelCount(page)).toBe(0);
  await page.evaluate(() => { const g = (window as any).__gate; g.held = false; g.open(); });
  await settled(page);
  expect(await labelCount(page)).toBeGreaterThan(0);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(tileDiff(await snapshot(page), empty)).toEqual([]);
  await expect(undoButton(page)).toBeDisabled();
});

test("opening another raster clears the history (criterion 5)", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  const painted = await snapshot(page);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click(); // the class 2 stroke
  const one = pixels(await snapshot(page));
  expect(one.length).toBeLessThan(pixels(painted).length);
  expect(one.every(([, , v]) => v === 1)).toBe(true);
  await expect(undoButton(page)).toBeEnabled(); // the class 1 stroke is still there
  page.on("dialog", (d) => void d.accept());
  await openRaster(page, anotherRaster()); // spec 031 would offer the same raster's saved labels back
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await expect(undoButton(page)).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await labelCount(page)).toBe(0);
});
