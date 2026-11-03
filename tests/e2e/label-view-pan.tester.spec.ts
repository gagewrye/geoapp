import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { hoverFeatures, jumpTo, message, openApp, openRaster, paintMode, renameClass, rgbFixture, stroke, toScreen, view, type Xy } from "./helpers";
import { expectFileHolds, gateWrites, openWrite, seeded, setup as twoClasses, writeHeld } from "./lockCombos";
import { classList, importFile, noSavePicker, openFileGate, pauseLabelFile, storeTiles, upload } from "./seeding";

// Tester edge cases for spec 016's amended rule "Hiding selects Pan": locks, Space, work while hidden.

const show = (page: Page) => page.locator("#show-labels");
const toggleShow = (page: Page) => show(page).dispatchEvent("click");
const mode = (page: Page) => page.evaluate(() => ({
  paint: document.getElementById("mode-paint")!.getAttribute("aria-pressed"),
  pan: document.getElementById("mode-pan")!.getAttribute("aria-pressed"),
}));
const PAN = { paint: "false", pan: "true" }, PAINT = { paint: "true", pan: "false" };
const cursorAt = (page: Page, p: Xy) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [p.x, p.y] as const);
const visibilities = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  const out = new Set<string>();
  for (const { id } of map.getStyle().layers as { id: string }[]) {
    if (id.startsWith("label-") || id === "mask") out.add(map.getLayoutProperty(id, "visibility") ?? "visible");
  }
  return [...out];
});
const drag = async (page: Page, a: Xy, button: "left" | "right" = "left") =>
  stroke(page, [a, ...Array.from({ length: 10 }, (_, i) => ({ x: a.x + 6 * (i + 1), y: a.y + 3 * (i + 1) }))], button);
async function centre(page: Page): Promise<Xy> {
  const box = (await page.locator("#map canvas").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("during an import lock, clicking Paint while hidden shows labels and selects Paint, but the lock still blocks (not-allowed, no paint)", async ({ page }) => {
  await setup(page);
  await jumpTo(page, [15, 45], 9);
  const p = await centre(page);
  await pauseLabelFile(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect.poll(() => page.evaluate(() => (window as any).__fileGate.reads)).toBeGreaterThan(0);
  await expect(page.locator("#class-add")).toBeDisabled();
  await toggleShow(page);
  expect(await mode(page)).toEqual(PAN);
  await page.locator("#mode-paint").dispatchEvent("click");
  await expect(show(page)).toBeChecked();
  expect(await mode(page)).toEqual(PAINT);
  await page.mouse.move(p.x, p.y);
  await page.mouse.move(p.x + 2, p.y);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  expect(await hoverFeatures(page)).toEqual([]);
  const v0 = await view(page);
  await page.mouse.down(); // raw moves: stroke() waits for Import labels, which the import keeps disabled
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + 2 + 6 * i, p.y + 3 * i);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect((await view(page)).lng).toBe(v0.lng); // locked Paint: neither paints nor pans
  expect((await storeTiles(page)).size).toBe(0);
  await openFileGate(page);
  await expect(message(page)).toHaveText(seeded);
  expect(await mode(page)).toEqual(PAN); // a finishing import selects Pan anyway
  await expect(show(page)).toBeChecked();
});

test("during an Export lock, hiding selects Pan (MapLibre's cursor, drag pans); Paint shows labels with not-allowed until the export ends", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await twoClasses(page);
  const tiles = await storeTiles(page);
  const p = await centre(page);
  const downloaded = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await page.mouse.move(p.x, p.y);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await toggleShow(page);
  expect(await mode(page)).toEqual(PAN);
  await page.mouse.move(p.x + 2, p.y);
  const c = await cursorAt(page, p);
  expect(c).not.toBe("not-allowed");
  expect(c.startsWith("url(")).toBe(false);
  const v0 = await view(page);
  await drag(page, p);
  expect((await view(page)).lng).not.toBe(v0.lng);
  await page.locator("#mode-paint").dispatchEvent("click");
  await expect(show(page)).toBeChecked();
  expect(await visibilities(page)).toEqual(["visible"]);
  expect(await mode(page)).toEqual(PAINT);
  expect(await cursorAt(page, p)).toBe("not-allowed");
  await drag(page, p);
  expect(await storeTiles(page)).toEqual(tiles);
  await openWrite(page);
  await downloaded;
  await expect(message(page)).toHaveText("Labels exported.");
  expect(await mode(page)).toEqual(PAINT); // an export doesn't change the mode
  expect((await cursorAt(page, p)).startsWith('url("data:image/svg+xml')).toBe(true);
});

test("an Export that ends while hidden leaves Pan and Show labels unchecked", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await gateWrites(page);
  await twoClasses(page);
  const downloaded = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await toggleShow(page);
  await openWrite(page);
  await downloaded;
  await expect(message(page)).toHaveText("Labels exported.");
  expect(await mode(page)).toEqual(PAN);
  await expect(show(page)).not.toBeChecked();
});

test("Space while hidden: holding it and dragging pans; releasing it keeps Pan and labels hidden", async ({ page }) => {
  await setup(page);
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(a.x, a.y);
  await page.keyboard.down("Space"); // Paint mode, labels shown: Space acts as Pan
  await toggleShow(page);
  expect(await mode(page)).toEqual(PAN);
  const v0 = await view(page);
  await drag(page, a);
  expect((await view(page)).lng).not.toBe(v0.lng);
  await page.keyboard.up("Space");
  expect(await mode(page)).toEqual(PAN);
  await expect(show(page)).not.toBeChecked();
  await page.mouse.move(a.x + 3, a.y + 3);
  expect(await hoverFeatures(page)).toEqual([]);
  const v1 = await view(page);
  await drag(page, a);
  expect((await view(page)).lng).not.toBe(v1.lng);
  expect((await storeTiles(page)).size).toBe(0);
});

test("while hidden: add, rename and recolour classes, Ctrl+Z, and Export labels all work; labels stay hidden and Pan stays selected", async ({ page }) => {
  test.setTimeout(120_000);
  await noSavePicker(page);
  await twoClasses(page);
  await toggleShow(page);
  await page.click("#class-add");
  expect((await classList(page)).length).toBe(3);
  await renameClass(page, 2, "third");
  expect((await classList(page))[2]!.name).toBe("third");
  await page.locator("#classes .class-colour").nth(1).fill("#123456");
  expect((await classList(page))[1]!.colour).toBe("#123456");
  expect(await visibilities(page)).toEqual(["none"]); // recolour redraws overlays, still hidden
  const tiles = await storeTiles(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-labels")]);
  await expect(message(page)).toHaveText("Labels exported.");
  await expectFileHolds((await dl.path())!, tiles, ["left", "right", "third"]);
  await page.locator("#mode-pan").focus();
  await page.keyboard.press("Control+z");
  expect(await storeTiles(page)).not.toEqual(tiles);
  expect(await visibilities(page)).toEqual(["none"]);
  expect(await mode(page)).toEqual(PAN);
  await expect(show(page)).not.toBeChecked();
});
