import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { jumpTo, message, openApp, openRaster, rgbFixture, type Xy } from "./helpers";
import { gateWrites, openWrite, seeded, setup as twoClasses, writeHeld } from "./lockCombos";
import { importFile, noSavePicker, openFileGate, pauseLabelFile, upload } from "./seeding";

// Spec 010 criterion 8: while labels are locked (spec 004) the map shows not-allowed, not the brush.
const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const selectedColour = (page: Page) => page.locator("#classes li.selected .class-colour").inputValue();
async function centre(page: Page): Promise<Xy> {
  const box = (await page.locator("#map canvas").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function expectBrush(page: Page, p: Xy) {
  const cursor = await cursorAt(page, p);
  expect(cursor.startsWith('url("data:image/svg+xml')).toBe(true);
  expect(decodeURIComponent(cursor).toLowerCase()).toContain((await selectedColour(page)).toLowerCase());
}
/** Pan mode shows MapLibre's cursor, then Paint mode is restored. */
async function panModeIsMapLibres(page: Page, p: Xy) {
  await page.click("#mode-pan");
  await page.mouse.move(p.x, p.y);
  const c = await cursorAt(page, p);
  expect(c).not.toBe("not-allowed");
  expect(c.startsWith("url(")).toBe(false);
  await page.click("#mode-paint");
  await page.mouse.move(p.x, p.y);
}

test("during an import the map shows not-allowed, grabbing while middle-panning, and the brush once it ends", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 9);
  const p = await centre(page);
  await page.mouse.move(p.x, p.y);
  await expectBrush(page, p);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await page.mouse.move(p.x, p.y);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await page.mouse.move(p.x + 15, p.y + 5);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await page.mouse.down({ button: "middle" });
  for (let i = 1; i <= 4; i++) await page.mouse.move(p.x + 15 + 10 * i, p.y + 5 + 3 * i);
  expect(await cursorAt(page, p)).toBe("grabbing");
  await page.mouse.up({ button: "middle" });
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await panModeIsMapLibres(page, p);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  await expectBrush(page, p); // no pointer move since
});

test("during an Export labels run the map shows not-allowed, and the brush once it ends", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await twoClasses(page);
  const p = await centre(page);
  await page.mouse.move(p.x, p.y);
  await expectBrush(page, p);
  const downloaded = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await page.mouse.move(p.x, p.y);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await panModeIsMapLibres(page, p);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await openWrite(page);
  await downloaded;
  await expect(message(page)).toHaveText("Labels exported.");
  await expectBrush(page, p); // no pointer move since
});
