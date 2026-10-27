import { expect, test } from "@playwright/test";
import { message } from "./helpers";
import { expectFileHolds, expectLock, gateWrites, loadModel, modelJson, openWrite, reopen, seeded, setup, trained, writeHeld } from "./lockCombos";
import { classList, noSavePicker, openImageryGate, pauseImagery, storeTiles } from "./seeding";

// Spec 004's shared lock, part 2: Export labels with seeds, Trains and Load model.

test("Load model and a seed on a raster opened mid-export: A's write ending keeps B locked while B's seed runs", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  const json = await modelJson(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await reopen(page);
  await loadModel(page, json); // Load model during A's export
  await expect(message(page)).toHaveText("Loaded model with classes: left, right.");
  await expect(page.locator("#seed-model")).toBeEnabled();
  await pauseImagery(page); // B's reads
  await page.click("#seed-model"); // no labels on B: replaces, no confirm
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await expectLock(page, true, "B seeding");
  await openWrite(page);
  await dl;
  await expect(message(page)).toHaveText("Labels exported.");
  await expectLock(page, true, "A's export ended, B's seed still runs");
  await expect(page.locator("#train")).toBeDisabled();
  await openImageryGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expectLock(page, false, "B's seed ended");
});

test("a stale seed dropping on a raster whose export runs keeps the export's lock; the export ending lifts it", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  await pauseImagery(page); // A's reads
  await page.click("#seed-model"); // Merge: no confirm
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await reopen(page);
  await expectLock(page, false, "B opened mid-seed");
  const dl = page.waitForEvent("download");
  const list = (await classList(page)).map((c) => c.name); // the list outlives a raster open
  await page.click("#export-labels"); // B has no labels: an all-zero file
  await writeHeld(page);
  await expectLock(page, true, "export on B");
  await openImageryGate(page); // A's seed sees it is stale and drops
  await page.waitForTimeout(500);
  await expectLock(page, true, "A's seed dropped, B's export runs");
  expect((await storeTiles(page)).size).toBe(0);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, new Map(), list);
  await expectLock(page, false, "B's export ended");
});

test("a Merge seed during an export: the lock outlasts the seed, the file holds the click's labels and classes", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  const tiles = await storeTiles(page);
  const json = await modelJson(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  // a model loaded mid-export with other names: a Merge seed appends them
  await loadModel(page, JSON.stringify({ ...JSON.parse(json), classes: ["p", "q"] }));
  await expect(message(page)).toHaveText("Loaded model with classes: p, q.");
  await page.click("#seed-model");
  await expect(message(page)).toHaveText(seeded);
  expect((await classList(page)).map((c) => c.name)).toEqual(["left", "right", "p", "q"]);
  await expectLock(page, true, "seed ended, export runs");
  const seededTiles = await storeTiles(page);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended");
  expect(await storeTiles(page)).toEqual(seededTiles);
});

test("a Train during an export, and an export during a Train: only the export locks, and it reads no imagery", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  const tiles = await storeTiles(page);
  await pauseImagery(page);
  await page.click("#train");
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBeGreaterThan(0);
  await expectLock(page, false, "Train runs");
  const dl1 = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await expectLock(page, true, "export during Train");
  await openImageryGate(page);
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
  await expectLock(page, true, "Train ended, export runs");
  await openWrite(page);
  await expectFileHolds((await (await dl1).path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended");

  // an export started and finished while a Train's imagery reads are held
  await pauseImagery(page);
  await page.click("#train");
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBeGreaterThan(0);
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#export-labels")]);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl2.path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended, Train still runs");
  await openImageryGate(page);
  await expect(message(page)).toHaveText(/^Trained on/);
});

test("a seed started during an export on the same raster: the export ending keeps the lock until the seed ends", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await trained(page);
  const tiles = await storeTiles(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await pauseImagery(page);
  await page.click("#seed-model"); // Merge: no confirm
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectLock(page, true, "export ended, seed runs");
  await expect(page.locator("#export-labels")).toBeDisabled(); // while seeding
  await openImageryGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expectLock(page, false, "seed ended");
  await expect(page.locator("#export-labels")).toBeEnabled();
});
