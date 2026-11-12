import { expect, test, type Page } from "@playwright/test";
import { footprint, footprintRing, pixelAt } from "../../src/core/pixel";
import { clickAt, editName, hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, RGB_GRID, rgbFixture, toLngLat, toScreen, view } from "./helpers";

// Spec 017 criteria 2 (slider), 3 (keys) and 4 (Space).

const range = (page: Page) => page.locator("#brush-size-range");
const sizeText = (page: Page) => page.locator("#brush-size");
async function expectSize(page: Page, n: number) {
  await expect(sizeText(page)).toHaveText(`${n}`);
  await expect(range(page)).toHaveValue(String(n));
}

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
}

test("the slider is 1-127 step 2 at 7; at 41 a click labels the 41 x 41 square on pixelAt and the ring matches (criterion 2)", async ({ page }) => {
  await setup(page);
  for (const [k, v] of [["type", "range"], ["min", "1"], ["max", "127"], ["step", "2"]]) await expect(range(page)).toHaveAttribute(k!, v!);
  await expectSize(page, 7);
  await range(page).fill("41");
  await expectSize(page, 41);
  const c = await toScreen(page, [15.005, 45.005]);
  await clickAt(page, c);
  const [lon, lat] = (await toLngLat(page, [c]))[0]!;
  const [col, row] = pixelAt(RGB_GRID, lon, lat);
  const want = new Set<string>();
  for (let r = row - 20; r <= row + 20; r++) for (let x = col - 20; x <= col + 20; x++) want.add(`${x},${r}`);
  await expect.poll(async () => (await labels(page)).size).toBe(41 * 41);
  expect(new Set((await labels(page)).keys())).toEqual(want);
  const ring = footprintRing(RGB_GRID, footprint(RGB_GRID, col, row, 41)!);
  await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
  const got = (await hoverFeatures(page))[0].geometry.coordinates[0] as [number, number][];
  expect(got).toHaveLength(ring.length);
  got.forEach(([x, y], i) => { expect(Math.abs(x - ring[i]![0])).toBeLessThan(1e-9); expect(Math.abs(y - ring[i]![1])).toBeLessThan(1e-9); });
});

test("] and [ halve and double between 1 and 127; with the slider focused ] still steps and ArrowRight adds 2 (criterion 3)", async ({ page }) => {
  await setup(page);
  await page.locator("#map canvas").focus();
  for (const n of [15, 31, 63, 127, 127]) { await page.keyboard.press("]"); await expectSize(page, n); }
  for (const n of [63, 31, 15, 7, 3, 1, 1]) { await page.keyboard.press("["); await expectSize(page, n); }
  for (const n of [3, 7]) { await page.keyboard.press("]"); await expectSize(page, n); }
  await range(page).focus();
  await page.keyboard.press("ArrowRight");
  await expectSize(page, 9);
  await page.keyboard.press("]");
  await expectSize(page, 19);
  await expect(range(page)).toBeFocused();
  // typed in a class name field, [ and ] change nothing
  await editName(page, 0);
  await page.keyboard.type("[]]");
  await expectSize(page, 19);
});

test("Space after a mouse click on the slider pans and keeps the size; after Tab to it, Space doesn't pan (criterion 4)", async ({ page }) => {
  await setup(page);
  await range(page).click();
  await expect(range(page)).toBeFocused();
  const size = await range(page).inputValue();
  const c = await toScreen(page, [15.005, 45.005]);
  const v0 = await view(page);
  await page.keyboard.down("Space");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + 8 * i, c.y + 4 * i);
  await page.mouse.up();
  await page.keyboard.up("Space");
  expect((await view(page)).lng).not.toBe(v0.lng);
  expect((await labels(page)).size).toBe(0);
  await expectSize(page, Number(size));

  await page.click("#brush-smaller");
  await page.keyboard.press("Tab");
  await expect(range(page)).toBeFocused();
  await page.evaluate(() => {
    const g = (window as any).__space = [] as boolean[];
    window.addEventListener("keydown", (e) => { if (e.code === "Space") g.push(e.defaultPrevented); });
  });
  await page.keyboard.down("Space");
  expect(await page.evaluate(() => (window as any).__space)).toEqual([false]);
  await expect(page.locator(".maplibregl-canvas-container")).toHaveClass(/brush-cursor/); // still Paint, not Pan
  await page.keyboard.up("Space");
});
