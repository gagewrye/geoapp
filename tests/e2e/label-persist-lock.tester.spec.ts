import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture, tileKeysStored, toScreen } from "./helpers";
import { holdIdb, storeTiles } from "./seeding";

// Tester, spec 031 criterion 11 / scope 4 in the browser: from "Raster opened." until the restore offer has settled,
// strokes change no tile and Undo, Import labels and Export labels are disabled. The session lookup and the restore's
// tile reads are held in IndexedDB so both halves of the lock (before the prompt, and while tiles load after OK) can be seen.

/** A stroke with no wait for settling (Import labels stays disabled under the lock). */
async function rawStroke(page: Page, at: [number, number]) {
  const a = await toScreen(page, at);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + 10 * i, a.y + 3 * i);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function expectLocked(page: Page, tiles: string[]) {
  for (const id of ["#import-labels", "#export-labels", "#undo"]) await expect(page.locator(id), id).toBeDisabled();
  if (await page.locator("#mode-paint").isEnabled()) await page.click("#mode-paint");
  await rawStroke(page, [13.005, 46.505]);
  expect(await tileKeysStored(page)).toEqual(tiles);
}

test("the labels stay locked until the restore offer settles: before the prompt, and while an accepted restore loads", async ({ page }) => {
  test.setTimeout(120_000);
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.type()); void d.accept(); });
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await paintTwoClasses(page);
  await expect(page.locator("#save-state")).toHaveText(/^Saved /, { timeout: 15_000 });
  await page.waitForTimeout(2500);
  const saved = await storeTiles(page);
  const keys = [...saved.keys()].sort();

  await page.addInitScript(holdIdb);
  await page.reload();
  await expect(page.locator("#map[data-ready=true]")).toBeVisible();
  expect(dialogs).toEqual([]);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 6);
  await expectLocked(page, []); // lookup held: no prompt yet
  expect(dialogs).toEqual([]);

  await page.evaluate(() => (window as any).__idb.get.open());
  await expect.poll(() => dialogs.length).toBe(1); // the prompt, accepted
  await expectLocked(page, []); // tiles held: still loading the restore

  await page.evaluate(() => (window as any).__idb.tiles.open());
  await expect(message(page)).toHaveText("Labels restored.");
  for (const id of ["#import-labels", "#export-labels"]) await expect(page.locator(id), id).toBeEnabled();
  const back = await storeTiles(page);
  expect([...back.keys()].sort()).toEqual(keys); // nothing from the locked strokes
  for (const [k, t] of saved) expect(Buffer.from(back.get(k)!).equals(Buffer.from(t)), k).toBe(true);

  if (!(await page.locator("#mode-paint").getAttribute("aria-pressed") === "true")) await paintMode(page);
  await rawStroke(page, [15.505, 43.505]); // tile 512,512: none of the restored ones
  await expect.poll(async () => (await tileKeysStored(page)).length).toBeGreaterThan(keys.length);
});
