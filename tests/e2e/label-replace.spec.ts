import { expect, test, type Page } from "@playwright/test";
import { paletteColour } from "../../src/core/classes";
import { MESSAGES } from "../../src/ui/messages";
import { classFile } from "../unit/helpers/labelFiles";
import { hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture, rgbNodataFixture, settled, toScreen } from "./helpers";
import { classList, holdMasks, importFile, openFileGate, openImageryGate, pauseImagery, pauseLabelFile, storeTiles, upload } from "./seeding";

// Spec 004 criterion 16 (as amended) and spec 017 criterion 5: every import replaces, after a confirm when labels exist,
// and what's disabled while seeding or painting.

const classes = () => upload("classes.tif", classFile("255"));
const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
async function setup(page: Page, raster = rgbFixture()) {
  await openApp(page);
  await holdMasks(page);
  await openRaster(page, raster);
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
}
/** Fails the test on any dialog until `allow` is called. */
function noDialogs(page: Page) {
  const fail = (d: { message(): string }) => { throw new Error(`unexpected dialog ${d.message()}`); };
  page.on("dialog", fail);
  return () => page.off("dialog", fail);
}

test("there is no Seed mode; with no labels an import shows no confirm, and Undo is disabled after it", async ({ page }) => {
  await setup(page);
  noDialogs(page);
  await expect(page.locator("#seed-mode")).toHaveCount(0);
  await importFile(page, classes());
  await expect(message(page)).toHaveText(seeded);
  await expect(page.locator("#undo")).toBeDisabled();
});

test("with painted tiles an import confirms: Cancel keeps labels, classes and the class map, OK replaces them and disables Undo", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  await expect(page.locator("#undo")).toBeEnabled();
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  await page.setInputFiles("#class-map", upload("map.json", JSON.stringify([{ value: 3, name: "Water" }])));
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await importFile(page, classes());
  await expect.poll(() => asked).toEqual([MESSAGES.replace]);
  await page.waitForTimeout(300);
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  expect(await page.locator("#class-map").evaluate((e) => (e as HTMLInputElement).files?.[0]?.name)).toBe("map.json"); // kept for the next try
  page.once("dialog", (d) => { asked.push(d.message()); void d.accept(); });
  await page.setInputFiles("#import-labels", classes()); // the class map chosen before Cancel applies
  await expect(message(page)).toHaveText(seeded);
  expect(asked).toEqual([MESSAGES.replace, MESSAGES.replace]);
  expect(await classList(page)).toEqual([{ name: "Water", colour: paletteColour(0) }]);
  expect(new Set((await labels(page)).values())).toEqual(new Set([1]));
  await expect(page.locator("#undo")).toBeDisabled();
  // a second import, over imported labels only, replaces them too (spec 014 criterion 10 covers a mask-only store)
  page.once("dialog", (d) => { asked.push(d.message()); void d.accept(); });
  await importFile(page, classes());
  await expect.poll(() => asked.length).toBe(3);
  await expect(message(page)).toHaveText(seeded);
  expect(await classList(page)).toEqual(["Class 0", "Class 3", "Class 7"].map((name, i) => ({ name, colour: paletteColour(i) })));
  expect(new Set((await labels(page)).values())).toEqual(new Set([1, 2, 3]));
});

test("while an import runs the brush and class edits are disabled; while mask reads are pending Import labels and Export labels are", async ({ page }) => {
  await setup(page, rgbNodataFixture()); // its masks need reads (spec 023 F2)
  await paintTwoClasses(page);
  const before = await labels(page);
  await pauseLabelFile(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, classes());
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  for (const id of ["#export-labels", "#import-labels", "#class-add"]) await expect(page.locator(id)).toBeDisabled();
  await expect(page.locator("#classes .class-rename").first()).toBeDisabled();
  // a drag paints nothing and shows no footprint
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [16.005, 45.505]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 10);
  expect(await hoverFeatures(page)).toEqual([]);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await labels(page)).toEqual(before);
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  // unlocked, the same point shows the footprint again once Paint is chosen (an import selects Pan: spec 014 Tests)
  await paintMode(page);
  await page.mouse.move(a.x + 1, a.y);
  await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
  await expect(page.locator("#classes .class-rename").first()).toBeEnabled();

  // a dab on row band 4 waits for its read: the background is held, and the strokes and their hovers (spec 023 F3) read bands near 45N
  await pauseImagery(page);
  await jumpTo(page, [11.5, 38.5], 6);
  const b = await toScreen(page, [11.505, 38.505]);
  await page.mouse.click(b.x, b.y);
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBeGreaterThan(0); // spec 020's display reads are held too
  await expect(page.locator("#import-labels")).toBeDisabled();
  await expect(page.locator("#export-labels")).toBeDisabled(); // its file must hold no half-applied stroke
  await openImageryGate(page);
  await settled(page);
  await expect(page.locator("#import-labels")).toBeEnabled();
  await expect(page.locator("#export-labels")).toBeEnabled();
});

