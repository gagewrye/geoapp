import { expect, test, type Page } from "@playwright/test";
import { anotherRaster, jumpTo, labels, message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture, settled, toScreen, type Xy } from "./helpers";

// Spec 010: undo of paint and erase strokes (button and Ctrl+Z), and the brush cursor.
const undoButton = (page: Page) => page.locator("#undo");
const snapshot = async (page: Page) => [...(await labels(page))].sort();

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
    const g = (window as any).__gate = { held: true, open: null as null | (() => void), wait: null as null | Promise<void> };
    g.wait = new Promise<void>((r) => { g.open = r; });
    // spec 023: masks are read through readSamples, by band; the setup paused the background reads
    for (const m of ["readWindow", "readSamples"]) {
      const read = s[m].bind(s);
      s[m] = async (...a: unknown[]) => { if (g.held) await g.wait; return read(...a); };
    }
  });
  const c = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y);
  await expect(undoButton(page)).toBeDisabled(); // during the stroke
  await page.mouse.move(c.x + 300, c.y + 200); // into more tiles
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(undoButton(page)).toBeDisabled(); // after it, cells still waiting
  expect((await labels(page)).size).toBe(0);
  await page.evaluate(() => { const g = (window as any).__gate; g.held = false; g.open(); });
  await settled(page);
  expect((await labels(page)).size).toBeGreaterThan(0);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(await snapshot(page)).toEqual(empty);
  await expect(undoButton(page)).toBeDisabled();
});

test("opening another raster clears the history (criterion 5)", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  const painted = await snapshot(page);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click(); // the class 2 stroke
  const one = await snapshot(page);
  expect(one.length).toBeLessThan(painted.length);
  expect(one.every(([, v]) => v === 1)).toBe(true);
  await expect(undoButton(page)).toBeEnabled(); // the class 1 stroke is still there
  page.on("dialog", (d) => void d.accept());
  await openRaster(page, anotherRaster()); // spec 031 would offer the same raster's saved labels back
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await expect(undoButton(page)).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await snapshot(page)).toEqual([]);
});

const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const classColour = (page: Page, i: number) => page.evaluate((i) => (window as any).__geoapp.labels.classes[i].colour as string, i);
function expectBrush(cursor: string, colour: string) {
  expect(cursor.startsWith('url("data:image/svg+xml')).toBe(true);
  expect(decodeURIComponent(cursor).toLowerCase()).toContain(colour.toLowerCase());
  expect(cursor.endsWith("crosshair")).toBe(true);
}

test("the brush cursor shows the selected colour in Paint mode only (criterion 7)", async ({ page }) => {
  await openApp(page);
  const box = (await page.locator("#map canvas").boundingBox())!;
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false); // no imagery
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await page.mouse.move(p.x, p.y);
  expectBrush(await cursorAt(page, p), await classColour(page, 0));
  await page.keyboard.press("2");
  expectBrush(await cursorAt(page, p), await classColour(page, 1));
  await page.locator("#classes .class-colour").nth(1).fill("#12ab34");
  expectBrush(await cursorAt(page, p), "#12ab34");
  const panel = (await page.locator("#panel").boundingBox())!;
  expect((await cursorAt(page, { x: panel.x + 10, y: panel.y + panel.height - 10 })).startsWith("url(")).toBe(false);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Space");
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false);
  await page.keyboard.up("Space");
  expectBrush(await cursorAt(page, p), "#12ab34");
  await page.click("#mode-pan");
  expect((await cursorAt(page, p)).startsWith("url(")).toBe(false);
});
