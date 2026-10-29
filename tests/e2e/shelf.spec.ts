import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { aefShapedFile, classFile } from "../unit/helpers/labelFiles";
import { jumpTo, logRequests, message, openApp, openRaster, rgbFixture, settled, stroke, tiff, toScreen } from "./helpers";
import { download, importFile, noSavePicker, upload } from "./seeding";

// Spec 013: AlphaEarth and training are shelved; the site only labels local imagery.

const SHELVED_IDS = ["train", "classify", "save-model", "load-model", "seed-model", "min-confidence"];
const ids = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[id]")].map((e) => e.id));
const layerIds = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: any) => l.id as string));
const sourceIds = (page: Page): Promise<string[]> => page.evaluate(() => Object.keys((window as any).__geoapp.map.getStyle().sources));

async function openAndPaint(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
}

test("no shelved control is in the page, and the panel names neither AlphaEarth nor a model (criterion 1)", async ({ page }) => {
  await openApp(page);
  const check = async (why: string) => {
    const all = await ids(page);
    expect(all.filter((id) => SHELVED_IDS.includes(id) || id.includes("aef")), why).toEqual([]);
    const text = (await page.locator("#panel").textContent()) ?? "";
    expect(text, why).not.toMatch(/alphaearth|model/i);
  };
  await check("at load");
  await openAndPaint(page);
  await check("with imagery open and labels");
});

test("layers: background, basemap, preview, label overlays, then hover; none is AlphaEarth or terra-draw (criterion 5)", async ({ page }) => {
  await openApp(page);
  await openAndPaint(page);
  await expect.poll(async () => (await layerIds(page)).some((id) => id.startsWith("brush-hover"))).toBe(true);
  // overlays are created on the frame after a stroke applies, so wait for them before reading the order
  await expect.poll(async () => (await layerIds(page)).some((id) => id.startsWith("label-"))).toBe(true);
  const layers = await layerIds(page);
  const labelLayers = layers.filter((id) => id.startsWith("label-"));
  expect(labelLayers.length).toBeGreaterThan(0);
  expect(layers).toEqual(["background", "basemap", "preview", ...labelLayers, "brush-hover-fill", "brush-hover-line"]);
  for (const id of [...layers, ...(await sourceIds(page))]) {
    expect(id).not.toContain("aef");
    expect(id.startsWith("td-")).toBe(false);
  }
});

test("every request from load through open, paint, undo, import, export and another open stays on the app's origin (criterion 6)", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
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
  await page.waitForTimeout(300);
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

test("an AlphaEarth-shaped file opens as 64-band imagery, and Import labels refuses it (criterion 8)", async ({ page }) => {
  await openApp(page);
  const file = upload("aef-shaped.tif", aefShapedFile());
  await openRaster(page, file);
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(page.locator("#raster-info")).toContainText("64 band(s)");
  await expect(page.locator("#brush-panel")).toBeVisible();
  await importFile(page, file);
  await expect(message(page)).toHaveText(MESSAGES.labelFile);
  expect(MESSAGES.labelFile).toBe("Label files must be single-band 8-bit GeoTIFFs.");
});

test("the build has no terra-draw, Source Cooperative or catalog index (criterion 2)", () => {
  // Playwright's web server builds dist/ before any test runs
  expect(existsSync("dist/index.html")).toBe(true);
  expect(existsSync("dist/aef-index")).toBe(false);
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const hits = files("dist").filter((f) => /terra-draw|source\.coop|aef-index/.test(readFileSync(f, "latin1")));
  expect(hits).toEqual([]);
});
