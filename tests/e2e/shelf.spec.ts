import { expect, test, type Page } from "@playwright/test";
import { classFile } from "../unit/helpers/labelFiles";
import { jumpTo, logRequests, message, openApp, openRaster, overlaysIdle, paintMode, rgbFixture, settled, stroke, tiff, toScreen } from "./helpers";
import { download, importFile, noSavePicker, upload } from "./seeding";

// Spec 013: AlphaEarth and training are shelved; the site only labels local imagery.


async function openAndPaint(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
}

test("every request from load through open, paint, undo, import, export and another open stays on the app's origin (criterion 6)", async ({ page, baseURL }) => {
  const log = logRequests(page);
  await noSavePicker(page);
  await openApp(page);
  await openAndPaint(page);
  await page.click("#undo");
  await paintBeside(page);
  page.once("dialog", (d) => void d.accept()); // "Replace labels?": every import replaces (spec 017)
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(/^Seeded \d+ pixels in \d+ classes\.$/);
  await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  page.once("dialog", (d) => void d.accept()); // Discard labels?
  await openRaster(page, tiff("other.tif", 300, 300, 3, (b, c, r) => (c + r + b) % 200, { epsg: 4326, gt: [12, 0.01, 0, 47, 0, -0.01] }));
  await expect(page.locator("#raster-info")).toHaveText(/^other\.tif/);
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.saving())).toBe(false); // the label saves have ended (spec 072: no fixed wait)
  await overlaysIdle(page);
  const app = new URL(baseURL!);
  const urls = log.map((r) => r.url()).filter((u) => !u.startsWith("data:"));
  expect(urls.length).toBeGreaterThan(0);
  for (const u of urls) {
    // a blob: URL names the origin that made it
    const url = new URL(u.startsWith("blob:") ? u.slice(5) : u);
    expect(url.origin, u).toBe(app.origin);
    expect(url.pathname.startsWith(app.pathname.replace(/\/?$/, "/")), u).toBe(true);
    expect(/aef-index\/.*\.json$/.test(url.pathname), u).toBe(false);
  }
});

/** A second stroke beside the first, so an import has labels to merge with. */
async function paintBeside(page: Page) {
  const a = await toScreen(page, [15.005, 45.01]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  await settled(page);
}
