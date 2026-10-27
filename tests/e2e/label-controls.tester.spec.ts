import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { MESSAGES } from "../../src/ui/messages";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, paintTwoClasses, rgbFixture, stroke, tiff, toScreen } from "./helpers";
import { classList, importFile, openFileGate, openImageryGate, pauseImagery, pauseLabelFile, storeTiles, upload } from "./seeding";

// Tester checks of spec 004's controls: Min. confidence values, Seed mode after erasing everything,
// Seed's model check against a newly opened raster, what a model seed locks, the replaced-raster
// rule for an import that fails, and a run that survives a cancelled "Discard labels?".

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}
async function trained(page: Page) {
  await setup(page);
  await paintTwoClasses(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on/);
  await expect(page.locator("#seed-model")).toBeEnabled();
}

test("Min. confidence: empty, below 0 and above 1 disable Seed with the message; 0 and 1 enable it and clear the message", async ({ page }) => {
  await trained(page);
  const field = page.locator("#min-confidence");
  await expect(field).toHaveValue("0");
  await expect(field).toHaveAttribute("step", "0.05");
  for (const v of ["", "-0.05", "1.05", "2"]) {
    await field.fill(v);
    await expect(message(page), v).toHaveText(MESSAGES.minConfidence);
    await expect(page.locator("#seed-model"), v).toBeDisabled();
    await field.fill("1");
    await expect(page.locator("#seed-model")).toBeEnabled();
    await expect(message(page)).toHaveText("");
  }
  await field.fill("0");
  await expect(page.locator("#seed-model")).toBeEnabled();
});

test("erasing every label disables Seed mode again and resets it to Merge", async ({ page }) => {
  await setup(page);
  await jumpTo(page, [15, 45], 7);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 20, y: a.y }]);
  await expect(page.locator("#seed-mode")).toBeEnabled();
  await page.selectOption("#seed-mode", "replace");
  await page.click("#brush-larger"); await page.click("#brush-larger"); await page.click("#brush-larger");
  await stroke(page, [{ x: a.x - 10, y: a.y }, { x: a.x + 30, y: a.y }], "right");
  expect((await labels(page)).size).toBe(0);
  await expect(page.locator("#seed-mode")).toBeDisabled();
  await expect(page.locator("#seed-mode")).toHaveValue("merge");
  // and the next import replaces with no confirm
  page.on("dialog", (d) => { throw new Error(`unexpected dialog ${d.message()}`); });
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
});

test("Seed is disabled once a raster opens whose band count the model doesn't fit", async ({ page }) => {
  await trained(page);
  page.once("dialog", (d) => void d.accept()); // Discard labels?
  await openRaster(page, tiff("one.tif", 200, 200, 1, (_b, c) => c, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }));
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(page.locator("#seed-model")).toBeDisabled();
  await expect(page.locator("#import-labels")).toBeEnabled();
});

test("while a model seed runs, the brush, class edits, Train, Import, Seed, Seed mode and Export are disabled; keys still select", async ({ page }) => {
  await trained(page);
  const before = await labels(page);
  await pauseImagery(page);
  await page.click("#seed-model");
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await expect(message(page)).toHaveText("Seeding labels...");
  for (const id of ["#train", "#seed-model", "#export-labels", "#import-labels", "#class-map", "#class-add", "#seed-mode"]) await expect(page.locator(id), id).toBeDisabled();
  for (const sel of ["#classes .class-name", "#classes .class-colour"]) {
    const n = await page.locator(sel).count();
    for (let i = 0; i < n; i++) await expect(page.locator(sel).nth(i)).toBeDisabled();
  }
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.keyboard.press("2");
  await expect(page.locator("#classes li").nth(1)).toHaveAttribute("aria-selected", "true");
  // left and right drags change nothing and read nothing more
  const a = await toScreen(page, [16.005, 45.505]);
  for (const button of ["left", "right"] as const) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button });
    await page.mouse.move(a.x + 40, a.y + 10, { steps: 4 });
    await page.mouse.up({ button });
  }
  expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await openImageryGate(page);
  await expect(message(page)).toHaveText(seeded);
  for (const id of ["#train", "#seed-model", "#export-labels", "#import-labels", "#class-add", "#seed-mode"]) await expect(page.locator(id), id).toBeEnabled();
  const after = await labels(page);
  for (const [k, v] of before) expect(after.get(k), k).toBe(v); // Merge kept the painted pixels
});

test("an import that fails after another raster opened shows no message and changes nothing (spec 003's replaced-raster rule)", async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page);
  // the next opened label file's reads wait, then fail
  await page.evaluate(() => {
    const g = (window as any).__fileGate = { reads: 0, open: null as null | (() => void) };
    const wait = new Promise<void>((r) => { g.open = r; });
    (window as any).__geoapp.labelFile = (f: { read: (w: unknown) => Promise<Uint8Array> }) => {
      f.read = async () => { g.reads++; await wait; throw new Error("read failed"); };
    };
  });
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  const list = await classList(page);
  await openRaster(page, { ...rgbFixture(), name: "other.tif" }); // no labels: no confirm
  await expect(message(page)).toHaveText("Raster opened.");
  await openFileGate(page);
  await page.waitForTimeout(500);
  await expect(message(page)).toHaveText("Raster opened.");
  expect((await storeTiles(page)).size).toBe(0);
  expect(await classList(page)).toEqual(list);
  await expect(page.locator("#import-labels")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("a run whose raster stays because Discard labels? was cancelled still applies", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  const painted = await labels(page);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255"))); // Merge: no confirm
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect.poll(() => asked).toEqual([MESSAGES.discard]);
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  const after = await labels(page);
  expect(after.size).toBeGreaterThan(painted.size);
  for (const [k, v] of painted) expect(after.get(k), k).toBe(v);
  expect((await classList(page)).map((c) => c.name)).toEqual(["left", "right", "Class 0", "Class 3", "Class 7"]);
});

test("a Replace model seed asks first: Cancel changes nothing and reads no imagery", async ({ page }) => {
  await trained(page);
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  await pauseImagery(page);
  await page.selectOption("#seed-mode", "replace");
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await page.click("#seed-model");
  await expect.poll(() => asked).toEqual([MESSAGES.replace]);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(0);
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  await expect(page.locator("#seed-model")).toBeEnabled();
  await expect(page.locator("#classes .class-name").first()).toBeEnabled();
});
