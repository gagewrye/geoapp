import { expect, test, type Page } from "@playwright/test";
import { labels, message } from "./helpers";
import { expectFileHolds, gateWrites, openWrite, setup as twoClasses, writeHeld } from "./lockCombos";
import { noSavePicker, storeTiles } from "./seeding";

// Tester edge case for spec 010 with spec 004 built: Undo while an export holds the labels.
const undoButton = (page: Page) => page.locator("#undo");
const snapshot = async (page: Page) => [...(await labels(page))].sort();

test("an Export labels run after an Undo writes the store as undone; the remaining step still undoes", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await twoClasses(page);
  await undoButton(page).click(); // the class 2 stroke
  const atClick = await storeTiles(page);
  const downloaded = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await expect(undoButton(page)).toBeDisabled();
  await openWrite(page);
  const dl = await downloaded;
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl.path())!, atClick, ["left", "right"]);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(await snapshot(page)).toEqual([]);
  await expect(undoButton(page)).toBeDisabled();
});
