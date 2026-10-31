import { expect, test, type Page } from "@playwright/test";
import { pixelAt } from "../../src/core/pixel";
import { formatLonLat } from "../../src/core/status";
import { jumpTo, message, openApp, openRaster, paintMode, RGB_GRID, rgbFixture, rgbTiled, selectClass, toLngLat, toScreen } from "./helpers";
import { at, holdMasks, importFile, maskFile, pauseLabelFile } from "./seeding";

// Spec 032 criteria 3-6.
const field = (page: Page, id: string) => page.locator(`#status #${id}`);

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("the pointer over a known pixel shows its px and lon/lat; off the raster px blanks; zooming changes z (criterion 3)", async ({ page }) => {
  await setup(page);
  await jumpTo(page, [15, 45], 10); // a raster pixel is about 23 screen px
  const p = await toScreen(page, at(500.5, 499.5)); // pixel 500, 499's centre
  await page.mouse.move(Math.round(p.x), Math.round(p.y));
  const [[lon, lat]] = await toLngLat(page, [{ x: Math.round(p.x), y: Math.round(p.y) }]) as [[number, number]];
  expect(pixelAt(RGB_GRID, lon, lat)).toEqual([500, 499]);
  await expect(field(page, "status-px")).toHaveText("px 500, 499");
  const m = (await field(page, "status-lonlat").textContent())!.match(/^([\d.]+) N ([\d.]+) E$/)!;
  expect(Math.abs(Number(m[1]) - lat)).toBeLessThan(1e-4);
  expect(Math.abs(Number(m[2]) - lon)).toBeLessThan(1e-4);
  expect(formatLonLat(Number(m[2]), Number(m[1]))).toBe(m[0]);
  await jumpTo(page, [5, 45], 7); // west of the raster's 10E edge
  const off = await toScreen(page, [4, 45]);
  await page.mouse.move(off.x, off.y);
  await expect(field(page, "status-px")).toHaveText("");
  await expect(field(page, "status-lonlat")).not.toHaveText("");
  await expect(field(page, "status-zoom")).toHaveText("z 7.0");
  await jumpTo(page, [5, 45], 9);
  await expect(field(page, "status-zoom")).toHaveText("z 9.0");
});

test("] , selecting class 2 and selecting Paint each update the tool (criterion 4)", async ({ page }) => {
  await setup(page);
  const tool = field(page, "status-tool");
  await expect(tool).toHaveText("Pan · Class 1 · 7 px");
  await page.locator("#map canvas").click({ position: { x: 5, y: 5 } }); // focus off the inputs, as a user would
  await page.keyboard.press("]"); // stepBrush: 7 -> 15
  await expect(tool).toHaveText("Pan · Class 1 · 15 px");
  await selectClass(page, 1);
  await expect(tool).toHaveText("Pan · Class 2 · 15 px");
  await paintMode(page);
  await expect(tool).toHaveText("Paint · Class 2 · 15 px");
});

test("opening shows #open-progress in #status; an import shows #import-progress and Cancel there, and Cancel cancels (criterion 5)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbTiled());
  await expect(page.locator("#status #open-progress")).toBeVisible();
  await expect(message(page)).toHaveText("Raster opened.");
  await holdMasks(page);
  await pauseLabelFile(page);
  await importFile(page, maskFile());
  await expect(page.locator("#status #import-progress")).toBeVisible();
  await expect(page.locator("#status #import-cancel")).toBeVisible();
  await page.locator("#status #import-cancel").click();
  await page.evaluate(() => (window as any).__fileGate.open());
  await expect(message(page)).toHaveText("Import cancelled.");
  await expect(page.locator("#status #import-cancel")).toBeHidden();
});

for (const [w, h] of [[1280, 720], [800, 600]] as const) {
  test(`#status stays in the viewport at ${w}x${h}, under the map (criterion 6)`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openApp(page);
    const bar = (await page.locator("#status").boundingBox())!, map = (await page.locator("#map").boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(h + 0.5);
    expect(bar.height).toBeCloseTo(28, 0);
    expect(bar.width).toBeCloseTo(w, 0);
    expect(map.y + map.height).toBeLessThanOrEqual(bar.y + 0.5);
    await expect(page.locator("#status")).toBeVisible(); // before any raster opens
    await expect(field(page, "status-px")).toHaveText("");
  });
}
