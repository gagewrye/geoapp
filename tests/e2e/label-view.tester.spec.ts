import { expect, test, type Page } from "@playwright/test";
import { pixelAt as cellAt } from "../../src/core/pixel";
import { MESSAGES } from "../../src/ui/messages";
import { classFile } from "../unit/helpers/labelFiles";
import { jumpTo, labels, message, openApp, openRaster, paintMode, RGB_GRID, rgbFixture, settled, stroke, toLngLat, toScreen, view, type Xy } from "./helpers";
import { importFile, maskFile, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

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

test("hiding labels mid-stroke ends the stroke: later moves paint nothing, even after showing again with the button held", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(a.x + 4 * i, a.y);
  await settled(page);
  await page.waitForTimeout(100);
  const before = await labels(page);
  expect(before.size).toBeGreaterThan(0);
  await toggleShow(page); // hidden while the button is held
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + 20, a.y + 8 * i);
  await toggleShow(page); // shown again, button still held: no new stroke without a press
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + 20 + 8 * i, a.y + 80);
  await page.mouse.up();
  await page.waitForTimeout(200);
  await settled(page);
  expect(await labels(page)).toEqual(before);
});

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

test("Pan mode with labels hidden: a left drag pans and says nothing", async ({ page }) => {
  await setup(page);
  await toggleShow(page);
  await jumpTo(page, [15, 45], 9);
  await message(page).evaluate((e) => { e.textContent = ""; });
  const a = await toScreen(page, [15.005, 45.005]);
  const v0 = await view(page);
  await stroke(page, [a, ...Array.from({ length: 10 }, (_, i) => ({ x: a.x + 6 * (i + 1), y: a.y + 3 * (i + 1) }))]);
  expect((await view(page)).lng).not.toBe(v0.lng);
  await expect(message(page)).toHaveText("");
  expect((await storeTiles(page)).size).toBe(0);
});

test("opacity at 0 and 100, live text on keyboard input, and the value survives hide and show", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 10, y: a.y }]);
  for (const [v, o] of [["0", 0], ["100", 1]] as const) {
    await opacity(page).fill(v);
    await expect(page.locator("#label-opacity-text")).toHaveText(`Opacity: ${v}%`);
    expect(await labelLayers(page)).toEqual({ "label-256,256": [o, "visible"] });
  }
  await opacity(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(opacity(page)).toHaveValue("95");
  await expect(page.locator("#label-opacity-text")).toHaveText("Opacity: 95%");
  expect(await labelLayers(page)).toEqual({ "label-256,256": [0.95, "visible"] });
  await toggleShow(page);
  await toggleShow(page);
  expect(await labelLayers(page)).toEqual({ "label-256,256": [0.95, "visible"] });
});

test("the brush size is kept when another raster opens (spec 017)", async ({ page }) => {
  await setup(page);
  await page.locator("#brush-size-range").fill("41");
  await expect(page.locator("#brush-size")).toHaveText("Brush: 41 px");
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect(page.locator("#raster-info")).toContainText("other.tif");
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(page.locator("#brush-size")).toHaveText("Brush: 41 px");
  await expect(page.locator("#brush-size-range")).toHaveValue("41");
});

test("an even value on the slider snaps to an odd size that the text matches (spec 017)", async ({ page }) => {
  await setup(page);
  // Playwright's fill refuses off-step values, so set it as a script or assistive tech would, then fire input
  await page.locator("#brush-size-range").evaluate((e: HTMLInputElement) => { e.value = "40"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  const v = Number(await page.locator("#brush-size-range").inputValue());
  expect(v % 2).toBe(1);
  await expect(page.locator("#brush-size")).toHaveText(`Brush: ${v} px`);
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
  await expect(page.locator("#brush-size")).toHaveText("Brush: 15 px");
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

test("hidden while locked by an import: a press says labels are hidden and paints nothing", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await toggleShow(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await expect(page.locator("#class-add")).toBeDisabled(); // locked
  await message(page).evaluate((e) => { e.textContent = ""; });
  await page.mouse.click(a.x, a.y);
  await expect(message(page)).toHaveText(MESSAGES.labelsHidden);
  expect((await storeTiles(page)).size).toBe(0);
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
});
