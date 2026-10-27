import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { CLASS_MAP, classFile, rgbClassFile } from "../unit/helpers/labelFiles";
import { labels, message, openApp, openRaster, paintTwoClasses, rgbFixture } from "./helpers";
import { classList, importFile, openFileGate, pauseImagery, pauseLabelFile, storeTiles, upload } from "./seeding";

// Tester checks of spec 004's build clarifications (awaiting Gage): the class map input after each
// import (criteria 12, 16), selecting during an import (16), and a loaded model with duplicate
// class names (17).

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const classMapFiles = (page: Page) => page.evaluate(() => (document.getElementById("class-map") as HTMLInputElement).files?.length ?? 0);
const mapFile = () => upload("map.json", JSON.stringify(CLASS_MAP));

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("the class map input is empty after an import that succeeds, one refused and one with an invalid map", async ({ page }) => {
  await setup(page);
  await importFile(page, upload("classes.tif", classFile("255")), mapFile());
  await expect(message(page)).toHaveText(seeded);
  expect(await classMapFiles(page)).toBe(0);
  // Merge from here on (labels exist): no confirm
  await importFile(page, upload("rgb.tif", rgbClassFile()), mapFile());
  await expect(message(page)).toHaveText(MESSAGES.labelFile);
  expect(await classMapFiles(page)).toBe(0);
  await importFile(page, upload("classes.tif", classFile("255")), upload("bad.json", "{"));
  await expect(message(page)).toHaveText(MESSAGES.classTable("JSON"));
  expect(await classMapFiles(page)).toBe(0);
  // and a later import without a map doesn't reuse the first one: classes come from the values
  await page.reload();
  await setup(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Class 0", "Class 3", "Class 7"]);
});

test("a cancelled Replace keeps the chosen class map, and the next import uses it", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  const before = { tiles: await storeTiles(page), list: await classList(page) };
  await page.selectOption("#seed-mode", "replace");
  page.once("dialog", (d) => void d.dismiss());
  await importFile(page, upload("classes.tif", classFile("255")), mapFile());
  await page.waitForTimeout(300);
  expect(await classMapFiles(page)).toBe(1);
  expect(await storeTiles(page)).toEqual(before.tiles);
  expect(await classList(page)).toEqual(before.list);
  page.once("dialog", (d) => void d.accept());
  await page.setInputFiles("#import-labels", upload("classes.tif", classFile("255"))); // the map stays as chosen
  await expect(message(page)).toHaveText(seeded);
  expect((await classList(page)).map((c) => c.name)).toEqual(["Seven", "Three"]);
  expect(await classMapFiles(page)).toBe(0);
});

test("while an import runs, selecting a class still works", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBe(1);
  await expect(page.locator("#class-add")).toBeDisabled();
  await page.locator("#classes li").nth(1).click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#classes li").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.keyboard.press("1");
  await expect(page.locator("#classes li").nth(0)).toHaveAttribute("aria-selected", "true");
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
});

test("a loaded model with duplicate class names shows its refusal, reads no imagery and seeds nothing, in either mode", async ({ page }) => {
  await setup(page);
  await paintTwoClasses(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on/);
  const model = await page.evaluate(() => (window as any).__geoapp.model());
  await page.setInputFiles("#load-model", { name: "dup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...model, classes: ["a", "a"] })) });
  await expect(message(page)).toHaveText("Loaded model with classes: a, a.");
  const before = { px: await labels(page), list: await classList(page) };
  await pauseImagery(page);
  for (const mode of ["merge", "replace"]) {
    await page.selectOption("#seed-mode", mode);
    if (mode === "replace") page.once("dialog", (d) => void d.accept()); // Replace's confirm
    await page.click("#seed-model");
    await expect(message(page)).toHaveText(MESSAGES.modelNames);
    expect(await page.evaluate(() => (window as any).__gate.reads)).toBe(0);
    expect(await labels(page)).toEqual(before.px);
    expect(await classList(page)).toEqual(before.list);
    await expect(page.locator("#class-add")).toBeEnabled();
    await expect(page.locator("#seed-model")).toBeEnabled();
    await page.evaluate(() => { document.getElementById("message")!.textContent = ""; });
  }
});
