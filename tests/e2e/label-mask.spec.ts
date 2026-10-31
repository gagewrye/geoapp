import { expect, test, type Page } from "@playwright/test";
import { paletteColour } from "../../src/core/classes";
import { toLonLat } from "../../src/core/crs";
import { footprint, pixelAt, strokeCells } from "../../src/core/pixel";
import { CLASS_GRID, classFile } from "../unit/helpers/labelFiles";
import {
  anotherRaster, clickAt, hideBasemap, jumpTo, labels, logRequests, message, openApp, openRaster, paintMode, path, pixelAt as screenPixel, renameClass, RGB_GRID, rgbFixture,
  selectClass, stroke, tileKeysStored, toLngLat, toScreen, type LngLat, type Xy,
} from "./helpers";
import { arrayBuffer, at, classList, download, importFile, maskFile, maskValue, noSavePicker, upload } from "./seeding";

// Spec 014 criteria 6 (fine-tune), 7 (undo), 9 (round trip), 10 (Replace), 11 (display), 13 (raster open, privacy) and 14 (classes).

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const undoButton = (page: Page) => page.locator("#undo");

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
}
/** Imports the mask (no labels yet: no confirm); an import selects Pan, so `paint` selects Paint again (spec 014 Tests). */
async function importMask(page: Page, paint = true) {
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(seeded);
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getLayer("mask") !== undefined)).toBe(true);
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  if (paint) await paintMode(page);
}

/** Every pixel under the size-7 footprints of a stroke through these screen points (same unproject and pixelAt as the app). */
async function covered(page: Page, pts: Xy[]): Promise<Set<string>> {
  const cells = (await toLngLat(page, pts)).map(([lon, lat]) => pixelAt(RGB_GRID, lon, lat));
  const out = new Set<string>();
  for (const [c, r] of cells.flatMap((c, i) => (i === 0 ? [c] : strokeCells(cells[i - 1]!, c)))) {
    const w = footprint(RGB_GRID, c, r, 7)!;
    for (let y = w.y0; y < w.y0 + w.height; y++) for (let x = w.x0; x < w.x0 + w.width; x++) out.add(`${x},${y}`);
  }
  return out;
}

/** Pixels of the given tiles whose effective label differs from want(c, r). */
function mismatches(got: Map<string, number>, keys: string[], want: (c: number, r: number) => number): string[] {
  const bad: string[] = [];
  for (const key of keys) {
    const [x0, y0] = key.split(",").map(Number) as [number, number];
    for (let r = y0; r < Math.min(y0 + 256, 1000); r++) for (let c = x0; c < Math.min(x0 + 256, 1000); c++) {
      if ((got.get(`${c},${r}`) ?? 0) !== want(c, r)) bad.push(`${c},${r}`);
    }
  }
  return bad;
}
const ALL = ["0,0", "256,0", "512,0", "768,0"].flatMap((k) => [0, 256, 512, 768].map((y) => `${k.split(",")[0]},${y}`));

test("fine-tune: a paint stroke across a base tile corner, a right drag, then two Undos (criteria 6 and 7)", async ({ page }) => {
  test.setTimeout(180_000);
  await setup(page);
  await importMask(page);
  expect(await tileKeysStored(page)).toEqual([]);
  const base = await labels(page);
  expect(mismatches(base, ALL, maskValue)).toEqual([]);

  await jumpTo(page, at(256, 256), 10);
  await selectClass(page, 1);
  const paint = path(await toScreen(page, at(250.5, 256.5)), await toScreen(page, at(262.5, 256.5)), 8);
  await stroke(page, paint);
  const painted = await covered(page, paint);
  const corner = ["0,0", "256,0", "0,256", "256,256"];
  expect(await tileKeysStored(page)).toEqual([...corner].sort());
  const afterPaint = await labels(page);
  expect(mismatches(afterPaint, ALL, (c, r) => (painted.has(`${c},${r}`) ? 2 : maskValue(c, r)))).toEqual([]);

  // erase class 1 over a part of the mask no stroke has touched
  await jumpTo(page, at(606, 600), 10);
  await selectClass(page, 0);
  const erase = path(await toScreen(page, at(584.5, 600.5)), await toScreen(page, at(596.5, 600.5)), 8); // blocks of 1 and 2
  await stroke(page, erase, "right");
  const erased = await covered(page, erase);
  expect([...erased].some((k) => { const [c, r] = k.split(",").map(Number) as [number, number]; return maskValue(c, r) === 1; })).toBe(true);
  expect(await tileKeysStored(page)).toEqual([...corner, "512,512"].sort());
  const afterErase = await labels(page);
  expect(mismatches(afterErase, ALL, (c, r) => {
    const v = painted.has(`${c},${r}`) ? 2 : maskValue(c, r);
    return erased.has(`${c},${r}`) && v === 1 ? 0 : v;
  })).toEqual([]);

  // criterion 7
  await undoButton(page).click();
  await undoButton(page).click();
  expect(mismatches(await labels(page), ALL, maskValue)).toEqual([]);
  expect(await tileKeysStored(page)).toEqual([]);
  await expect(undoButton(page)).toBeDisabled();
});

test("export, reopen and import the export with Replace restores every tile and the class list; no network requests (criteria 9 and 13)", async ({ page }) => {
  test.setTimeout(180_000);
  await noSavePicker(page);
  await setup(page);
  const requests = logRequests(page);
  await importMask(page);
  await jumpTo(page, at(400, 400), 10);
  await selectClass(page, 2);
  await stroke(page, path(await toScreen(page, at(380.5, 400.5)), await toScreen(page, at(420.5, 410.5)), 8));
  await selectClass(page, 0);
  await stroke(page, path(await toScreen(page, at(380.5, 420.5)), await toScreen(page, at(420.5, 420.5)), 8), "right");
  await renameClass(page, 0, "Mangrove & <salt>");
  await page.locator("#classes .class-colour").nth(1).fill("#12ab34");
  const before = await labels(page);
  const list = await classList(page);
  expect(list.map((c) => c.name)).toEqual(["Mangrove & <salt>", "Class 2", "Class 3"]);
  const file = await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  await page.waitForTimeout(300);
  expect(requests.map((r) => r.url())).toEqual([]);

  page.once("dialog", (d) => { expect(d.message()).toBe("Close these labels? They stay saved in this browser."); void d.accept(); });
  await openRaster(page, { ...rgbFixture(), name: "again.tif" });
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  // criterion 13: no labels and no mask layer
  expect(await page.evaluate(() => (window as any).__geoapp.map.getLayer("mask"))).toBeUndefined();
  expect((await labels(page)).size).toBe(0);
  page.on("dialog", (d) => { throw new Error(`unexpected dialog ${d.message()}`); });
  await importFile(page, upload("labels.tif", arrayBuffer(file)));
  await expect(message(page)).toHaveText(seeded);
  const back = await labels(page);
  expect(back.size).toBe(before.size);
  expect([...before].filter(([k, v]) => back.get(k) !== v)).toEqual([]);
  expect(await classList(page)).toEqual(list);
});

test("opening another raster after an import (OK on the confirm) leaves no labels and no mask layer (criterion 13)", async ({ page }) => {
  await setup(page);
  await importMask(page);
  page.once("dialog", (d) => void d.accept());
  await openRaster(page, anotherRaster()); // another raster: spec 031 would offer the same one's saved labels back
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  expect(await page.evaluate(() => (window as any).__geoapp.map.getLayer("mask"))).toBeUndefined();
  // hasLabels is false: the next open asks nothing
  page.on("dialog", (d) => { throw new Error(`unexpected dialog ${d.message()}`); });
  await openRaster(page, anotherRaster("third.tif"));
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
});

test("with only a mask loaded an import asks to replace: Cancel keeps the mask and classes, OK replaces the mask; Pan is selected (criterion 10)", async ({ page }) => {
  await setup(page);
  await importMask(page, false);
  expect(await tileKeysStored(page)).toEqual([]);
  const before = { labels: await labels(page), list: await classList(page) };
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => asked).toEqual(["Replace labels?"]);
  await page.waitForTimeout(300);
  expect(await labels(page)).toEqual(before.labels);
  expect(await classList(page)).toEqual(before.list);
  page.once("dialog", (d) => { asked.push(d.message()); void d.accept(); });
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  expect(asked).toEqual(["Replace labels?", "Replace labels?"]);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]);
  expect(await labels(page)).not.toEqual(before.labels);
  expect(await tileKeysStored(page)).toEqual([]);
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
});

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** The colour `over` drawn at the label opacity on `under`. */
const blend = (over: string, under: number[]) => rgb(over).map((v, i) => 0.6 * v + 0.4 * under[i]!);
const near = (got: number[], want: number[]) => want.every((v, i) => Math.abs(got[i]! - v) <= 3);
/** RGBA of the mask canvas at a lon/lat, located from the source's corners. */
const maskCanvasAt = (page: Page, p: LngLat) => page.evaluate((p) => {
  const s = (window as any).__geoapp.map.getSource("mask");
  const [[w, n], , [e, south]] = s.coordinates as [[number, number], [number, number], [number, number]];
  const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const c = s.canvas as HTMLCanvasElement;
  const x = Math.floor(((p[0] - w) / (e - w)) * c.width), y = Math.floor(((my(n) - my(p[1])) / (my(n) - my(south))) * c.height);
  return Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data);
}, p);

test("display: the mask shows blended at 0.6, a painted tile shows only its overlay, Undo brings the mask back, recolour repaints it (criterion 11)", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await hideBasemap(page);
  // two value-1 blocks in tile 256,256: (432..447, 416..431) and (464..479, 448..463)
  const probe = at(440, 424), probe2 = at(472, 456);
  await jumpTo(page, at(456, 440), 10);
  const p = await toScreen(page, probe), p2 = await toScreen(page, probe2);
  const under = await screenPixel(page, p), under2 = await screenPixel(page, p2);
  await importMask(page);
  await jumpTo(page, at(456, 440), 10);
  const colours = () => page.evaluate(() => (window as any).__geoapp.labels.classes.map((c: { colour: string }) => c.colour) as string[]);
  const [c1, c2] = await colours();
  await expect.poll(async () => near(await screenPixel(page, p), blend(c1!, under))).toBe(true);
  expect(near(await screenPixel(page, p2), blend(c1!, under2))).toBe(true);

  await selectClass(page, 1);
  await clickAt(page, p);
  await page.locator("#brush-panel").hover({ position: { x: 4, y: 4 } }); // no hover footprint over the probes
  await expect.poll(() => tileKeysStored(page)).toEqual(["256,256"]);
  // only the overlay: the new class where painted, the copied base elsewhere, each blended once
  await expect.poll(async () => near(await screenPixel(page, p), blend(c2!, under))).toBe(true);
  expect(near(await screenPixel(page, p2), blend(c1!, under2))).toBe(true);
  expect((await maskCanvasAt(page, probe2))[3]).toBe(0);

  await undoButton(page).click();
  await expect.poll(async () => near(await screenPixel(page, p), blend(c1!, under))).toBe(true);
  expect((await maskCanvasAt(page, probe2))).toEqual([...rgb(c1!), 255]);

  await page.locator("#classes .class-colour").nth(0).fill("#ff00ff");
  await expect.poll(async () => near(await screenPixel(page, p), blend("#ff00ff", under))).toBe(true);
  expect((await maskCanvasAt(page, probe2))).toEqual([255, 0, 255, 255]);
});

test("classes: the untagged 0/3/7/255 file gives Class 0, 3, 7, 255, and its value-0 pixels show Class 0's colour (criterion 14)", async ({ page }) => {
  await setup(page);
  await importFile(page, upload("classes-nond.tif", classFile(null)));
  await expect(message(page)).toHaveText(seeded);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7", "Class 255"]);
  // file block cols 0..23, rows 0..19 holds 0
  const zero = toLonLat(32633, CLASS_GRID.gt[0] + 12 * CLASS_GRID.gt[1], CLASS_GRID.gt[3] + 10 * CLASS_GRID.gt[5]);
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getLayer("mask") !== undefined)).toBe(true);
  expect(await maskCanvasAt(page, zero)).toEqual([...rgb(paletteColour(0)), 255]);
});
