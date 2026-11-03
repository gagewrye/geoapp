import { expect, test, type Page } from "@playwright/test";
import { pixelAt as cellAt } from "../../src/core/pixel";
import { classFile } from "../unit/helpers/labelFiles";
import { jumpTo, labels, message, openApp, openRaster, paintMode, RGB_GRID, rgbFixture, settled, toLngLat, toScreen, type Xy } from "./helpers";
import { importFile, maskFile, upload } from "./seeding";

// Tester edge cases for spec 016 (rules beyond the criteria) and spec 017's slider rules.

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const show = (page: Page) => page.locator("#show-labels");
const opacity = (page: Page) => page.locator("#label-opacity");
const toggleShow = (page: Page) => show(page).dispatchEvent("click");
const labelLayers = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  const out: Record<string, [number, string]> = {};
  for (const { id } of map.getStyle().layers as { id: string }[]) {
    if (!id.startsWith("label-") && id !== "mask") continue;
    // a tile's quads (label-${key}-${i}, spec 018) report as one entry, or as "mixed" if they disagree
    const k = id.replace(/^(label-[^-]+)-\d+$/, "$1");
    const v: [number, string] = [map.getPaintProperty(id, "raster-opacity"), map.getLayoutProperty(id, "visibility") ?? "visible"];
    out[k] = k in out && JSON.stringify(out[k]) !== JSON.stringify(v) ? [NaN, "mixed"] : v;
  }
  return out;
});
const cell = async (page: Page, p: Xy) => { const [ll] = await toLngLat(page, [p]); return cellAt(RGB_GRID, ll![0], ll![1]); };

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("overlays and the mask created by an import while hidden are hidden, keep the opacity, and show again", async ({ page }) => {
  await setup(page);
  await opacity(page).fill("35");
  await toggleShow(page);
  await expect(show(page)).not.toBeChecked();
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  await expect.poll(async () => Object.keys(await labelLayers(page)).length).toBeGreaterThan(0);
  const tiles = await labelLayers(page);
  for (const [id, v] of Object.entries(tiles)) expect([id, v]).toEqual([id, [0.35, "none"]]);
  await expect(show(page)).not.toBeChecked(); // an import doesn't reset Show labels (only an open does)
  page.once("dialog", (d) => void d.accept());
  await importFile(page, maskFile());
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getLayer("mask") !== undefined)).toBe(true);
  await expect(message(page)).toHaveText(seeded);
  expect((await labelLayers(page))["mask"]).toEqual([0.35, "none"]);
  await toggleShow(page);
  for (const v of Object.values(await labelLayers(page))) expect(v).toEqual([0.35, "visible"]);
});

test("a size change mid-stroke applies to later cells only (spec 017)", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 7);
  const a = await toScreen(page, [14.505, 45.005]);
  const a2 = { x: a.x + 60, y: a.y }, b = { x: a.x + 120, y: a.y };
  await page.locator("#map canvas").focus();
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + 10 * i, a.y);
  await page.keyboard.press("]"); // 7 -> 15
  await expect(page.locator("#brush-size")).toHaveText("15");
  for (let i = 1; i <= 6; i++) await page.mouse.move(a2.x + 10 * i, a.y);
  await page.mouse.up();
  await settled(page);
  const got = await labels(page);
  const [ca, ra] = await cell(page, a), [cb, rb] = await cell(page, b);
  expect(cb - ca).toBeGreaterThan(20); // the two halves are far apart in pixels
  expect(got.has(`${ca},${ra + 3}`)).toBe(true);
  expect(got.has(`${ca},${ra + 4}`)).toBe(false); // 7 px at the start
  expect(got.has(`${cb},${rb + 7}`)).toBe(true); // 15 px at the end
  expect(got.has(`${cb},${rb + 8}`)).toBe(false);
});
