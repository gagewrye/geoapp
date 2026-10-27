import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, labels, message, openRaster, rgbFixture, toScreen } from "./helpers";
import { drag, expectFileHolds, expectLock, gateWrites, opfsNames, openWrite, reopen, setup, writeHeld } from "./lockCombos";
import { classList, noSavePicker, openImageryGate, pauseImagery, storeTiles } from "./seeding";

// Spec 004's shared lock, part 1: Export labels alone, with the paint queue and with raster opens.

test("a Save dialog held open locks; cancelling it unlocks, and Export runs again", async ({ page }) => {
  await page.addInitScript(() => {
    const g = (window as any).__save = { opened: 0, cancel: null as null | (() => void) };
    (window as any).showSaveFilePicker = () => new Promise((_, rej) => {
      g.opened++;
      g.cancel = () => rej(new DOMException("The user aborted a request.", "AbortError"));
    });
  });
  await setup(page);
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__save.opened)).toBe(1);
  await expect(page.locator("#export-labels")).toBeDisabled();
  await expectLock(page, true, "dialog open");
  await page.evaluate(() => (window as any).__save.cancel());
  await expect(message(page)).toHaveText("The user aborted a request.");
  await expect(page.locator("#export-labels")).toBeEnabled();
  await expectLock(page, false, "dialog cancelled");
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__save.opened)).toBe(2);
  await page.evaluate(() => (window as any).__save.cancel());
  await expectLock(page, false, "second dialog cancelled");
});

test("a write that fails unlocks, leaves no file, and a retry exports the labels", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  await page.click("#export-labels");
  await writeHeld(page);
  await expect(page.locator("#export-labels")).toBeDisabled(); // one at a time
  await expectLock(page, true, "write held");
  await page.evaluate(() => (window as any).__writeGate.fail("disk full"));
  await expect(message(page)).toHaveText("disk full");
  await expect(page.locator("#export-labels")).toBeEnabled();
  await expectLock(page, false, "write failed");
  expect(await opfsNames(page)).toEqual([]);
  const tiles = await storeTiles(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-labels")]);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl.path())!, tiles, ["left", "right"]);
});

test("Export is a no-op while the paint queue is non-empty, even if its button is forced enabled", async ({ page }) => {
  await page.addInitScript(() => {
    const g = (window as any).__save = { opened: 0 };
    (window as any).showSaveFilePicker = () => { g.opened++; return new Promise(() => {}); };
  });
  await setup(page);
  await pauseImagery(page);
  await jumpTo(page, [11.5, 48.5], 6);
  const b = await toScreen(page, [11.505, 48.505]); // tile 0,0: no mask yet, so the dab waits for a read
  await page.mouse.click(b.x, b.y);
  await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
  await expect(page.locator("#export-labels")).toBeDisabled();
  await page.evaluate(() => { const e = document.getElementById("export-labels") as HTMLButtonElement; e.disabled = false; e.click(); });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__save.opened)).toBe(0);
  await expect(page.locator("#class-add")).toBeEnabled(); // no lock either
  await openImageryGate(page);
  await expect(page.locator("#export-labels")).toBeEnabled();
});

test("another raster opened mid-export is unlocked at once; Export waits for the old write, whose file holds the old labels", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  const tiles = await storeTiles(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await expectLock(page, true, "export on A");
  await reopen(page);
  await expectLock(page, false, "B opened");
  await expect(page.locator("#export-labels")).toBeDisabled(); // A's write still runs: one at a time
  // B can be painted while A writes
  await drag(page);
  await expect.poll(async () => (await labels(page)).size).toBeGreaterThan(0);
  const onB = await storeTiles(page);
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expect(page.locator("#export-labels")).toBeEnabled();
  await expectLock(page, false, "A's export ended");
  expect(await storeTiles(page)).toEqual(onB);
});

test("a raster open cancelled at Discard labels? mid-export keeps the lock until the write ends", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  const tiles = await storeTiles(page);
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await openRaster(page, { ...rgbFixture(), name: "other.tif" });
  await expect.poll(() => asked).toEqual([MESSAGES.discard]);
  await expectLock(page, true, "open cancelled");
  await openWrite(page);
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended");
});
