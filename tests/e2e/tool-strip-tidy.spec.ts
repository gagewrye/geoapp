import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, rgbFixture } from "./helpers";
import { applyMap, importFile, upload } from "./seeding";

// Spec 056 criteria 1, 2 and 7: + above the size and − below it; the file inputs show no text beside their button.

const ORDER = ["brush-larger", "brush-size", "brush-smaller", "brush-size-range"];
const size = (page: Page) => page.locator("#brush-size");

async function setup(page: Page) {
  page.on("dialog", (d) => void d.accept());
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("the brush strip reads +, size, −, slider in DOM order and top to bottom (criterion 1)", async ({ page }) => {
  await setup(page);
  const dom = await page.evaluate((ids) => [...document.querySelectorAll("#brush-panel *")].map((e) => e.id).filter((id) => ids.includes(id)), ORDER);
  expect(dom).toEqual(ORDER);
  const tops: number[] = [];
  for (const id of ORDER) tops.push((await page.locator(`#${id}`).boundingBox())!.y);
  for (let i = 1; i < tops.length; i++) expect(tops[i]!).toBeGreaterThan(tops[i - 1]!);
});

test("+ steps 7 to 15 and − back to 7; ] and [ do the same (criterion 2)", async ({ page }) => {
  await setup(page);
  await expect(size(page)).toHaveText("7");
  await page.click("#brush-larger");
  await expect(size(page)).toHaveText("15");
  await page.click("#brush-smaller");
  await expect(size(page)).toHaveText("7");
  await page.locator("#map canvas").focus();
  await page.keyboard.press("]");
  await expect(size(page)).toHaveText("15");
  await page.keyboard.press("[");
  await expect(size(page)).toHaveText("7");
});

const FILES = ["open-raster", "import-labels", "class-map"];
const alpha = (c: string) => { const m = /^rgba?\(([^)]*)\)$/.exec(c); const p = m ? m[1]!.split(/[\s,/]+/).filter(Boolean) : []; return p.length === 4 ? Number(p[3]) : p.length === 3 ? 1 : NaN; };
const colours = (page: Page) => page.evaluate((ids) => ids.map((id) => {
  const el = document.getElementById(id)!;
  return [id, getComputedStyle(el).color, getComputedStyle(el, "::file-selector-button").color];
}), FILES);
async function expectBlank(page: Page, when: string) {
  for (const [id, own, button] of await colours(page)) {
    expect(alpha(own!), `${id} text ${when}: ${own}`).toBe(0);
    expect(alpha(button!), `${id} button ${when}: ${button}`).toBe(1);
  }
}

test("each file input's own text is transparent and its button's is opaque, before and after a choice (criterion 7)", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await openApp(page);
  await expectBlank(page, "before any choice");
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await expectBlank(page, "after Open GeoTIFF");
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(/^Seeded \d+ pixels in \d+ classes\./);
  await expectBlank(page, "after Import labels");
  await applyMap(page, JSON.stringify([{ value: 3, name: "Water" }]));
  await expect(message(page)).toHaveText(/^Class map applied/);
  await expectBlank(page, "after Apply class map");
});
