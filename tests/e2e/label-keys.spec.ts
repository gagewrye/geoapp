import { expect, test, type Page } from "@playwright/test";
import { anotherRaster, jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, settled, stroke, toScreen } from "./helpers";

// Spec 034 criteria 4-7.
const pressed = (page: Page, id: "paint" | "erase" | "pan") => expect(page.locator(`#mode-${id}`)).toHaveAttribute("aria-pressed", "true");
const show = (page: Page) => page.locator("#show-labels");
/** The visibility of every label overlay and the mask. */
const visibilities = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  const ids = (map.getStyle().layers as { id: string }[]).map((l) => l.id).filter((id) => id.startsWith("label-") || id === "mask");
  return [...new Set(ids.map((id) => map.getLayoutProperty(id, "visibility") ?? "visible"))];
});

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 8);
  await paintMode(page);
}

test("holding ` hides the labels, a press paints nothing; releasing shows them in Paint mode and a stroke paints (criterion 4)", async ({ page }) => {
  await setup(page);
  const a = await toScreen(page, [14.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  const before = await labels(page);
  expect(before.size).toBeGreaterThan(0);
  expect(await visibilities(page)).toEqual(["visible"]);

  await page.keyboard.down("Backquote");
  await expect.poll(() => visibilities(page)).toEqual(["none"]);
  const b = await toScreen(page, [15.505, 45.405]);
  await stroke(page, [b, { x: b.x + 40, y: b.y }]);
  expect(await labels(page)).toEqual(before);
  await expect(show(page)).toBeChecked();
  await page.keyboard.up("Backquote");
  await expect.poll(() => visibilities(page)).toEqual(["visible"]);
  await pressed(page, "paint");
  await stroke(page, [b, { x: b.x + 40, y: b.y }]);
  expect((await labels(page)).size).toBeGreaterThan(before.size);
});

test("H hides the labels, unchecks Show labels and selects Pan; H again shows them (criterion 5)", async ({ page }) => {
  await setup(page);
  const a = await toScreen(page, [14.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  await page.keyboard.press("h");
  await expect(show(page)).not.toBeChecked();
  await pressed(page, "pan");
  await expect.poll(() => visibilities(page)).toEqual(["none"]);
  await page.keyboard.press("h");
  await expect(show(page)).toBeChecked();
  await expect.poll(() => visibilities(page)).toEqual(["visible"]);
  await pressed(page, "pan");
});

test("e pressed mid-stroke, then a new raster opened before mouse up: Erase is never pressed, and Pan is (criterion 6)", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as any).__erasePressed = seen;
    const el = document.getElementById("mode-erase")!;
    // records arrive after the task, so a value set and then reset in one task is read from the next record's oldValue
    new MutationObserver((records) => {
      records.forEach((_r, i) => { if ((records[i + 1]?.oldValue ?? el.getAttribute("aria-pressed")) === "true") seen.push("true"); });
    }).observe(el, { attributes: true, attributeOldValue: true, attributeFilter: ["aria-pressed"] });
  });
  await jumpTo(page, [10, 45], 6);
  const off = await toScreen(page, [7, 45]); // off the raster (10E-20E): the stroke labels nothing, so no discard confirm
  await page.mouse.move(off.x, off.y);
  await page.mouse.down();
  await page.keyboard.press("e");
  await openRaster(page, anotherRaster());
  await expect(page.locator("#raster-info")).toHaveText(/^other.tif/);
  await expect(message(page)).toHaveText("Raster opened.");
  await page.mouse.up();
  await pressed(page, "pan");
  expect(await page.evaluate(() => (window as any).__erasePressed)).toEqual([]);
});

test("p pressed mid-stroke keeps Paint until mouse up, then Pan is pressed (criterion 7)", async ({ page }) => {
  await setup(page);
  const a = await toScreen(page, [15.005, 45.005]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.keyboard.press("p");
  await page.mouse.move(a.x + 30, a.y);
  await pressed(page, "paint");
  await page.mouse.up();
  await pressed(page, "pan");
  await settled(page);
});
