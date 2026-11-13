import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { clickAt, hideBasemap, hoverFeatures, jumpTo, message, openApp, openRaster, paintMode, pixelAt, rgbFixture, selectClass, settled, stroke, tileKeysStored, toScreen, view, type Xy } from "./helpers";
import { at, classList, importFile, maskFile, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

// Spec 016: label Opacity, Show labels, hiding selects Pan, and Pan on load.

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const opacity = (page: Page) => page.locator("#label-opacity");
const opacityText = (page: Page) => page.locator("#label-opacity-text");
const show = (page: Page) => page.locator("#show-labels");
const pressed = (page: Page, id: "paint" | "pan") => expect(page.locator(`#mode-${id}`)).toHaveAttribute("aria-pressed", "true");
/** Toggles Show labels by a click event on the box, so the mouse pointer doesn't move. */
const toggleShow = (page: Page) => show(page).dispatchEvent("click");
/** raster-opacity and visibility of every label overlay and the mask, by id. */
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
const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const near = (got: number[], want: number[], tol: number) => want.every((v, i) => Math.abs(got[i]! - v) <= tol);
const colours = (page: Page) => page.evaluate(() => (window as any).__geoapp.labels.classes.map((c: { colour: string }) => c.colour) as string[]);

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}
/** The mask imported, then class 2 painted at `paintAt` (tile 256,256); returns the probes' screen points. */
async function maskAndTile(page: Page) {
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(seeded);
  await paintMode(page);
  // value-1 blocks in tile 256,256: one probed on the mask, one painted over with class 2
  const maskAt = at(472, 456), paintAt = at(440, 424);
  await jumpTo(page, at(456, 440), 10);
  const m = await toScreen(page, maskAt), p = await toScreen(page, paintAt);
  await selectClass(page, 1);
  await clickAt(page, p);
  await expect.poll(() => tileKeysStored(page)).toEqual(["256,256"]);
  await page.locator("#brush-panel").hover({ position: { x: 4, y: 4 } }); // no hover footprint over the probes
  return { m, p };
}

test("controls: Opacity 0-100 step 5 at 60, Show labels checked; both enabled during an import (criterion 1)", async ({ page }) => {
  await setup(page);
  await expect(opacity(page)).toHaveAttribute("type", "range");
  for (const [k, v] of [["min", "0"], ["max", "100"], ["step", "5"]]) await expect(opacity(page)).toHaveAttribute(k!, v!);
  await expect(opacity(page)).toHaveValue("60");
  await expect(opacityText(page)).toHaveText("60%");
  await expect(show(page)).toBeChecked();
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await expect(page.locator("#class-add")).toBeDisabled(); // locked
  await expect(opacity(page)).toBeEnabled();
  await expect(show(page)).toBeEnabled();
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
});

test("opacity 30 sets 0.3 on every overlay and the mask, and on a later tile; a pixel blends 0.7 imagery + 0.3 class (criterion 2)", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await hideBasemap(page);
  await jumpTo(page, at(456, 440), 10);
  const probes = { m: await toScreen(page, at(472, 456)), p: await toScreen(page, at(440, 424)) };
  const under = { m: await pixelAt(page, probes.m), p: await pixelAt(page, probes.p) };
  const { m, p } = await maskAndTile(page);
  expect([m, p]).toEqual([probes.m, probes.p]);
  await opacity(page).fill("30");
  await expect(opacityText(page)).toHaveText("30%");
  expect(await labelLayers(page)).toEqual({ "mask": [0.3, "visible"], "label-256,256": [0.3, "visible"] });
  const [c1, c2] = await colours(page);
  const blend = (hex: string, u: number[]) => rgb(hex).map((v, i) => 0.3 * v + 0.7 * u[i]!);
  await expect.poll(async () => near(await pixelAt(page, p), blend(c2!, under.p), 3)).toBe(true);
  expect(near(await pixelAt(page, m), blend(c1!, under.m), 3)).toBe(true);
  // a tile painted afterwards
  await jumpTo(page, at(100, 100), 10);
  await clickAt(page, await toScreen(page, at(100, 100)));
  await expect.poll(() => tileKeysStored(page)).toEqual(["0,0", "256,256"]);
  await expect.poll(async () => (await labelLayers(page))["label-0,0"]).toEqual([0.3, "visible"]);
});

test("hiding sets visibility none on the overlays and mask and shows the imagery; nothing else changes (criterion 4)", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await hideBasemap(page);
  await jumpTo(page, at(456, 440), 10);
  const probe = await toScreen(page, at(440, 424));
  const under = await pixelAt(page, probe);
  await maskAndTile(page);
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  await expect(page.locator("#undo")).toBeEnabled();
  await toggleShow(page);
  await expect(show(page)).not.toBeChecked();
  expect(await labelLayers(page)).toEqual({ "mask": [0.6, "none"], "label-256,256": [0.6, "none"] });
  await expect.poll(async () => near(await pixelAt(page, probe), under, 2)).toBe(true);
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  await expect(page.locator("#undo")).toBeEnabled();
  await toggleShow(page);
  await expect(show(page)).toBeChecked();
  const [, c2] = await colours(page);
  await expect.poll(async () => near(await pixelAt(page, probe), rgb(c2!).map((v, i) => 0.6 * v + 0.4 * under[i]!), 3)).toBe(true);
});

test("hiding labels in Paint mode selects Pan: a left drag pans, no footprint, no brush or not-allowed cursor, no message (criterion 5)", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 10, y: a.y }]);
  const tiles = await storeTiles(page);
  const said = await message(page).textContent();
  await toggleShow(page);
  await expect(show(page)).not.toBeChecked();
  await pressed(page, "pan");
  await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "false");
  const v0 = await view(page);
  await stroke(page, [{ x: a.x - 20, y: a.y + 5 }, ...Array.from({ length: 10 }, (_, i) => ({ x: a.x - 20 + 6 * (i + 1), y: a.y + 5 + 3 * (i + 1) }))]);
  expect((await view(page)).lng).not.toBe(v0.lng);
  expect(await storeTiles(page)).toEqual(tiles);
  const q = { x: a.x + 30, y: a.y + 30 };
  await page.mouse.move(q.x, q.y);
  expect(await hoverFeatures(page)).toEqual([]);
  const c = await cursorAt(page, q);
  expect(c.startsWith("url(")).toBe(false);
  expect(c).not.toBe("not-allowed");
  await expect(message(page)).toHaveText(said ?? "");
});

test("hiding labels mid-stroke by keyboard ends the stroke; later moves label nothing; one Undo removes it (criterion 5)", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(a.x + 4 * i, a.y);
  await settled(page);
  await page.waitForTimeout(100);
  await page.locator("#label-opacity").focus(); // after the press, which focuses the map
  await page.keyboard.press("Shift+Tab"); // Show comes before Opacity in the right panel (spec 035)
  await expect(show(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(show(page)).not.toBeChecked();
  await pressed(page, "pan");
  await settled(page);
  const painted = await storeTiles(page);
  expect(painted.size).toBeGreaterThan(0);
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + 20, a.y + 8 * i);
  await page.mouse.up();
  await page.waitForTimeout(200);
  await settled(page);
  expect(await storeTiles(page)).toEqual(painted);
  await page.click("#undo");
  expect(await tileKeysStored(page)).toEqual([]);
  await expect(page.locator("#undo")).toBeDisabled();
});

test("clicking Paint while hidden shows the labels, with the brush cursor and footprint at once (criterion 6)", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 10, y: a.y }]);
  await toggleShow(page);
  await pressed(page, "pan");
  const q = { x: a.x + 30, y: a.y + 30 };
  await page.mouse.move(q.x, q.y);
  expect(await hoverFeatures(page)).toEqual([]);
  await page.locator("#mode-paint").dispatchEvent("click"); // no pointer move
  await pressed(page, "paint");
  await expect(show(page)).toBeChecked();
  expect(await labelLayers(page)).toEqual({ "mask": [0.6, "visible"], "label-256,256": [0.6, "visible"] });
  expect((await cursorAt(page, q)).startsWith('url("data:image/svg+xml')).toBe(true);
  await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
});

test("hiding during an import selects Pan; after it finishes Pan is pressed and Show labels stays unchecked (criterion 6)", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await expect(page.locator("#class-add")).toBeDisabled(); // locked
  await pressed(page, "paint");
  await toggleShow(page);
  await expect(show(page)).not.toBeChecked();
  await pressed(page, "pan");
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  await pressed(page, "pan");
  await expect(show(page)).not.toBeChecked();
});
