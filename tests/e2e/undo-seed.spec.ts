import { expect, test, type Page } from "@playwright/test";
import { CLASS_GRID, classFile } from "../unit/helpers/labelFiles";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, labels, message, openApp, openRaster, rgbFixture, stroke, toScreen } from "./helpers";
import { expectFileHolds, gateWrites, openWrite, seeded, setup as twoClasses, writeHeld } from "./lockCombos";
import { importFile, noSavePicker, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

// Spec 010 criterion 5, the spec 004 clauses: seeds clear the history, refused or cancelled ones keep it,
// and Undo waits for imports and Export labels runs (labels.lock).
const undoButton = (page: Page) => page.locator("#undo");
const snapshot = async (page: Page) => [...(await labels(page))].sort();
const classes = () => upload("classes.tif", classFile("255"));

async function oneStroke(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 9);
  const empty = await snapshot(page);
  const c = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [c, { x: c.x + 60, y: c.y }]);
  await expect(undoButton(page)).toBeEnabled();
  return empty;
}

/** Undo disabled, and Ctrl+Z leaves the store as it is. */
async function undoBlocked(page: Page, why: string) {
  await expect(undoButton(page), why).toBeDisabled();
  const before = await snapshot(page);
  await page.locator("#map canvas").focus();
  await page.keyboard.press("Control+z");
  expect(await snapshot(page), why).toEqual(before);
}

test("a successful Merge import clears the history", async ({ page }) => {
  await oneStroke(page);
  await importFile(page, classes());
  await expect(message(page)).toHaveText(seeded);
  await expect(undoButton(page)).toBeDisabled();
});

test("a successful model seed clears the history", async ({ page }) => {
  await twoClasses(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on/);
  await expect(undoButton(page)).toBeEnabled();
  await page.click("#seed-model"); // Merge: no confirm
  await expect(message(page)).toHaveText(seeded);
  await expect(undoButton(page)).toBeDisabled();
});

test("a cancelled Replace confirm keeps the history; one Undo then removes the stroke", async ({ page }) => {
  const empty = await oneStroke(page);
  await page.selectOption("#seed-mode", "replace");
  page.once("dialog", (d) => { expect(d.message()).toBe(MESSAGES.replace); void d.dismiss(); });
  await importFile(page, classes());
  await page.waitForTimeout(300);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(await snapshot(page)).toEqual(empty);
});

test("an import showing 'No labels to seed here.' keeps the history; one Undo then removes the stroke", async ({ page }) => {
  const empty = await oneStroke(page);
  await importFile(page, upload("blank.tif", classFile("255", CLASS_GRID, () => 255)));
  await expect(message(page)).toHaveText(MESSAGES.noSeed);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(await snapshot(page)).toEqual(empty);
});

test("while an import runs (paused file) Undo is disabled and Ctrl+Z changes nothing", async ({ page }) => {
  await oneStroke(page);
  await pauseLabelFile(page);
  await importFile(page, classes());
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await undoBlocked(page, "import running");
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expect(undoButton(page)).toBeDisabled(); // the import replaced the store
});

test("while Export labels runs (paused sink) Undo is disabled; the file holds the store at its click; then the history is intact", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await twoClasses(page);
  const atClick = await storeTiles(page);
  const painted = await snapshot(page);
  const downloaded = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await undoBlocked(page, "export running");
  await openWrite(page);
  const dl = await downloaded;
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl.path())!, atClick, ["left", "right"]);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click(); // the class 2 stroke
  const one = await snapshot(page);
  expect(one.length).toBeLessThan(painted.length);
  expect(one.every(([, v]) => v === 1)).toBe(true);
  await expect(undoButton(page)).toBeEnabled(); // the class 1 stroke remains
});

test("an Undo that empties the store resets Seed mode to Merge and disables it", async ({ page }) => {
  await oneStroke(page);
  await expect(page.locator("#seed-mode")).toBeEnabled();
  await page.selectOption("#seed-mode", "replace");
  await undoButton(page).click();
  expect(await snapshot(page)).toEqual([]);
  await expect(page.locator("#seed-mode")).toHaveValue("merge");
  await expect(page.locator("#seed-mode")).toBeDisabled();
});
