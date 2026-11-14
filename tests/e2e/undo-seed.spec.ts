import { expect, test, type Page } from "@playwright/test";
import { CLASS_GRID, classFile } from "../unit/helpers/labelFiles";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, message, openApp, openRaster, paintMode, rgbFixture, stroke, toScreen } from "./helpers";
import { expectFileHolds, gateWrites, openWrite, seeded, setup as twoClasses, writeHeld } from "./lockCombos";
import { effectiveTiles, importFile, labelled, noSavePicker, openFileGate, pauseLabelFile, storeTiles, tileDiff, upload } from "./seeding";

// Spec 010 criterion 5, the spec 004 clauses: seeds clear the history, refused or cancelled ones keep it,
// and Undo waits for imports and Export labels runs (labels.lock).
const undoButton = (page: Page) => page.locator("#undo");
/** The effective labels, by tile (spec 072: compared with tileDiff, not through labels()). */
const snapshot = (page: Page) => effectiveTiles(page);
const pixels = (tiles: Map<string, Uint8Array>) => [...labelled(tiles, 1000)];
const classes = () => upload("classes.tif", classFile("255"));

async function oneStroke(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
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
  await page.keyboard.press("ControlOrMeta+z");
  expect(tileDiff(await snapshot(page), before), why).toEqual([]);
}

test("a successful import clears the history", async ({ page }) => {
  await oneStroke(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, classes());
  await expect(message(page)).toHaveText(seeded);
  await expect(undoButton(page)).toBeDisabled();
});

test("a cancelled Replace confirm keeps the history; one Undo then removes the stroke", async ({ page }) => {
  const empty = await oneStroke(page);
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await importFile(page, classes());
  await expect.poll(() => asked).toEqual([MESSAGES.replace]); // dismissed: the import stops at once (spec 072: no fixed wait)
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(tileDiff(await snapshot(page), empty)).toEqual([]);
});

test("an import showing 'No labels to seed here.' keeps the history; one Undo then removes the stroke", async ({ page }) => {
  const empty = await oneStroke(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, upload("blank.tif", classFile("255", CLASS_GRID, () => 255)));
  await expect(message(page)).toHaveText(MESSAGES.noSeed);
  await expect(undoButton(page)).toBeEnabled();
  await undoButton(page).click();
  expect(tileDiff(await snapshot(page), empty)).toEqual([]);
});

test("while an import runs (paused file) Undo is disabled and Ctrl+Z changes nothing", async ({ page }) => {
  await oneStroke(page);
  await pauseLabelFile(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, classes());
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await undoBlocked(page, "import running");
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expect(undoButton(page)).toBeDisabled(); // the import replaced the store
});

test("while Export labels runs (paused sink) Undo is disabled; the file holds the store at its click; then the history is intact", async ({ page }) => {
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
  const one = pixels(await snapshot(page));
  expect(one.length).toBeLessThan(pixels(painted).length);
  expect(one.every(([, , v]) => v === 1)).toBe(true);
  await expect(undoButton(page)).toBeEnabled(); // the class 1 stroke remains
});
