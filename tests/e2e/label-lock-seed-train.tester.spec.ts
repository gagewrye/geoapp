import { expect, test } from "@playwright/test";
import { message } from "./helpers";
import { expectFileHolds, expectLock, gateWrites, openWrite, setup, writeHeld } from "./lockCombos";
import { noSavePicker, pauseImagery, storeTiles } from "./seeding";

// Spec 004's shared lock, part 2: what an export locks and reads. Its seed, Train and Load model
// combinations went with spec 013.

test("an export locks until its write ends, and it reads no imagery", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  const tiles = await storeTiles(page);
  await pauseImagery(page);
  await expectLock(page, false, "before the export");
  const dl = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await expectLock(page, true, "export runs");
  await openWrite(page);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await (await dl).path())!, tiles, ["left", "right"]);
  await expectLock(page, false, "export ended");
  expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(0);
});
