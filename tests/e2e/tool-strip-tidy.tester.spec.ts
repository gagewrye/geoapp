import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, rgbFixture } from "./helpers";
import { importFile, upload } from "./seeding";

// Spec 056 edge cases (tester): Apply's visibility on the mode changes that don't come from a tool button or key,
// the hidden Apply out of the Tab order, and each blank file input still opening its chooser (criterion 8, headless part).

const apply = (page: Page) => page.locator("#smart-apply");
const smartOn = (page: Page) => expect(page.locator("#mode-smart")).toHaveAttribute("aria-pressed", "true");
const unfocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** A segmenter that never masks anything: enough to enter Smart without a model. */
const fakeSegmenter = (page: Page) => page.evaluate(() => {
  let held: string | null = null;
  (window as any).__geoapp.segmenter = {
    async encode(_i: Float32Array, key: string) { held = key; },
    has: (key: string) => held === key,
    async decode() { return { masks: new Float32Array(256 * 256).fill(-1), scores: new Float32Array(1), side: 256 }; },
  };
});

async function smart(page: Page) {
  page.on("dialog", (d) => void d.accept());
  await openApp(page);
  await fakeSegmenter(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await unfocus(page);
  await page.keyboard.press("m");
  await smartOn(page);
  await expect(apply(page)).toBeVisible();
}

test("hiding the labels (H) in Smart selects Pan and hides Apply", async ({ page }) => {
  await smart(page);
  await page.keyboard.press("h");
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(apply(page)).toBeHidden();
});

test("an import in Smart selects Pan and hides Apply", async ({ page }) => {
  await smart(page);
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(/^Seeded \d+ pixels in \d+ classes\./);
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(apply(page)).toBeHidden();
});

test("opening another raster keeps Apply's visibility in step with the Smart button", async ({ page }) => {
  await smart(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  const pressed = await page.locator("#mode-smart").getAttribute("aria-pressed");
  if (pressed === "true") await expect(apply(page)).toBeVisible();
  else await expect(apply(page)).toBeHidden();
});

test("in Pan the hidden Apply is skipped by Tab: Smart's button tabs straight to +", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await openApp(page);
  await fakeSegmenter(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.locator("#mode-smart").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#brush-larger")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#brush-smaller")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#brush-size-range")).toBeFocused();
});

test("with − focused, Shift+Tab focuses + (criterion 3)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.locator("#brush-smaller").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#brush-larger")).toBeFocused();
});

test("each blank file input still opens its chooser on a click (criterion 8, headless)", async ({ page }) => {
  // Open GeoTIFF goes through showOpenFilePicker where it exists (spec 050); recorded here, the native chooser checked below
  await page.addInitScript(() => {
    (window as any).__picked = 0;
    (window as any).showOpenFilePicker = () => { (window as any).__picked++; return Promise.reject(new DOMException("", "AbortError")); };
  });
  page.on("dialog", (d) => void d.accept());
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.locator("#open-raster").click();
  await expect.poll(() => page.evaluate(() => (window as any).__picked)).toBe(1);
  // Apply class map is enabled once labels are imported, so the import's chooser supplies them
  for (const [id, file, done] of [
    ["import-labels", upload("classes.tif", classFile("255")), /^Seeded \d+ pixels in \d+ classes\./],
    ["class-map", upload("map.json", JSON.stringify([{ value: 3, name: "Water" }])), /^Class map applied/],
  ] as const) {
    const input = page.locator(`#${id}`);
    await expect(input, id).toBeVisible();
    await expect(input, id).toBeEnabled();
    const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await input.click();
    await (await chooser).setFiles(file);
    await expect(message(page), id).toHaveText(done);
  }
});

test("without showOpenFilePicker, the blank Open GeoTIFF input opens the native chooser (criterion 8, headless)", async ({ page }) => {
  await page.addInitScript(() => { delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
  await page.locator("#open-raster").click();
  await (await chooser).setFiles(rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
});
