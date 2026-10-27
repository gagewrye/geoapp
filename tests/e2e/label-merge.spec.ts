import { expect, test, type Page } from "@playwright/test";
import { paletteColour } from "../../src/core/classes";
import { tileWindows } from "../../src/core/grid";
import { sourceCells } from "../../src/core/seed";
import { MESSAGES } from "../../src/ui/messages";
import { CLASS_GRID, classFile, classValue } from "../unit/helpers/labelFiles";
import { hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintTwoClasses, renameClass, RGB_GRID, rgbFixture, settled, toScreen } from "./helpers";
import { classList, importFile, openFileGate, openImageryGate, pauseImagery, pauseLabelFile, storeTiles, upload } from "./seeding";

// Spec 004 criterion 16: Merge, Replace, what's disabled while seeding or painting, and the class cap.

const classes = () => upload("classes.tif", classFile("255"));
const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}
/** Fails the test on any dialog until `allow` is called. */
function noDialogs(page: Page) {
  const fail = (d: { message(): string }) => { throw new Error(`unexpected dialog ${d.message()}`); };
  page.on("dialog", fail);
  return () => page.off("dialog", fail);
}

test("with no labels Seed mode is disabled and an import shows no confirm; with labels it is enabled with Merge selected", async ({ page }) => {
  await setup(page);
  noDialogs(page);
  await expect(page.locator("#seed-mode")).toBeDisabled();
  await importFile(page, classes());
  await expect(message(page)).toHaveText(seeded);
  await expect(page.locator("#seed-mode")).toBeEnabled();
  await expect(page.locator("#seed-mode")).toHaveValue("merge");
  await page.reload();
  await setup(page);
  await paintTwoClasses(page);
  await expect(page.locator("#seed-mode")).toBeEnabled();
  await expect(page.locator("#seed-mode")).toHaveValue("merge");
});

test("a Merge import shows no confirm, keeps every painted pixel's class, labels only unlabelled pixels and appends only new names", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page, ["Class 1", "Class 7"]); // "Class 7" matches an incoming name
  const painted = await labels(page);
  noDialogs(page);
  await importFile(page, classes());
  await expect(message(page)).toHaveText(seeded);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 1", "Class 7", "Class 0", "Class 3"]);
  const value: Record<number, number> = { 0: 3, 3: 4, 7: 2 }; // 255 is the file's nodata
  const tiles = await storeTiles(page);
  let bad = 0, added = 0;
  for (const w of tileWindows(1000, 1000)) {
    const t = tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height);
    const cells = sourceCells(RGB_GRID, CLASS_GRID, w);
    t.forEach((v, i) => {
      const p = painted.get(`${w.x0 + (i % w.width)},${w.y0 + Math.floor(i / w.width)}`);
      const want = p ?? (cells[2 * i]! < 0 ? 0 : value[classValue(cells[2 * i]!, cells[2 * i + 1]!)] ?? 0);
      if (v !== want) bad++;
      if (!p && v) added++;
    });
  }
  expect(bad).toBe(0);
  await expect(message(page)).toHaveText(`Seeded ${added} pixels in 3 classes.`);
});

test("Replace shows the confirm: Cancel keeps labels and classes, OK replaces them", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  await page.selectOption("#seed-mode", "replace");
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await importFile(page, classes());
  await expect.poll(() => asked).toEqual([MESSAGES.replace]);
  await page.waitForTimeout(300);
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  page.once("dialog", (d) => { asked.push(d.message()); void d.accept(); });
  await importFile(page, classes());
  await expect(message(page)).toHaveText(seeded);
  expect(asked).toEqual([MESSAGES.replace, MESSAGES.replace]);
  expect(await classList(page)).toEqual(["Class 0", "Class 3", "Class 7"].map((name, i) => ({ name, colour: paletteColour(i) })));
  expect(new Set((await labels(page)).values())).toEqual(new Set([1, 2, 3]));
});

test("while an import runs the brush, Train and class edits are disabled; while mask reads are pending Import labels, Seed and Export labels are", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on/);
  await expect(page.locator("#seed-model")).toBeEnabled();
  const before = await labels(page);
  await pauseLabelFile(page);
  await importFile(page, classes());
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  for (const id of ["#train", "#seed-model", "#export-labels", "#import-labels", "#class-add"]) await expect(page.locator(id)).toBeDisabled();
  await expect(page.locator("#classes .class-name").first()).toBeDisabled();
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
  // unlocked, the same point shows the footprint again
  await page.mouse.move(a.x + 1, a.y);
  await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
  await expect(page.locator("#train")).toBeEnabled();
  await expect(page.locator("#classes .class-name").first()).toBeEnabled();

  // a dab on tile 0,0 (no mask yet: nothing was painted or seeded there) waits for its read
  await pauseImagery(page);
  await jumpTo(page, [11.5, 48.5], 6);
  const b = await toScreen(page, [11.505, 48.505]);
  await page.mouse.click(b.x, b.y);
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await expect(page.locator("#import-labels")).toBeDisabled();
  await expect(page.locator("#seed-model")).toBeDisabled();
  await expect(page.locator("#export-labels")).toBeDisabled(); // its file must hold no half-applied stroke
  await openImageryGate(page);
  await settled(page);
  await expect(page.locator("#import-labels")).toBeEnabled();
  await expect(page.locator("#seed-model")).toBeEnabled();
  await expect(page.locator("#export-labels")).toBeEnabled();
});

test("a Merge passing 255 classes shows its message and changes nothing", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  // 253 classes through the hook: the file's 3 new names would make 256
  await page.evaluate(() => { const c = (window as any).__geoapp.labels.classes; for (let i = 3; i <= 253; i++) c.push({ name: `extra ${i}`, colour: "#000000" }); });
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  expect(before.list).toHaveLength(253);
  await importFile(page, classes());
  await expect(message(page)).toHaveText(MESSAGES.tooMany);
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  await renameClass(page, 0, "still editable");
});
