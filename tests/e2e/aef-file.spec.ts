import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { AefEntry } from "../../src/core/aef";
import { toLonLat } from "../../src/core/crs";
import { BACKGROUND } from "../../src/map/style";
import { AefFileError } from "../../src/io/aefLocal";
import { MESSAGES } from "../../src/ui/messages";
import { firstDiff } from "../unit/helpers/floats";
import { ATTRIBUTION, cacheFiles, chip, fetchChip, logRequests, refChip, serveAef } from "./aef";
import { jumpTo, message, openApp, openRaster, pixelAt, rgbFixture, toScreen } from "./helpers";

// "Open AlphaEarth file" (spec 002 Scope; criteria 14 and 15 in the UI), and "Open GeoTIFF"
// refusing AlphaEarth files, which are never a labelling surface.
const FIX = "tests/fixtures/aef";
const west = (JSON.parse(readFileSync(`${FIX}/aef-index/2021/32617.json`, "utf8")) as AefEntry[])[0]!; // west half, bottom-up
const westFile = () => ({ name: "west.tiff", mimeType: "image/tiff", buffer: readFileSync(`${FIX}/cogs/${west.path}`) });
const bg = [1, 3, 5].map((i) => parseInt(BACKGROUND.slice(i, i + 2), 16));
const isBackground = (px: number[]) => px.slice(0, 3).every((v, i) => Math.abs(v - bg[i]!) <= 3);
const N = chip.width;

/** Band 0 of the loaded AlphaEarth data over its whole grid, read through the app's source. */
const band0 = (page: Page) => page.evaluate(async () => {
  const { aoi, source } = (window as any).__geoapp.aef();
  const t = await source.readWindow(0, 0, aoi.width, aoi.height);
  return { aoi, values: Array.from(t.bands[0] as Float32Array, (v) => (Number.isNaN(v) ? null : v)) };
});

/** Requests other than the app's own static files (spec 001 criterion 1); decoders load as chunks. */
const network = (log: Request[], base: string) =>
  log.map((r) => r.url()).filter((u) => !u.startsWith("blob:") && !u.startsWith("data:") && !u.startsWith(`${base}assets/`));

test("opening a local AlphaEarth COG makes no requests, shows the preview and attribution, and keeps Train disabled (criteria 14, 15)", async ({ page, baseURL }) => {
  await openApp(page);
  const log = logRequests(page);
  await page.setInputFiles("#open-aef", westFile());
  await expect(message(page)).toHaveText("AlphaEarth file opened.");
  expect(network(log, `${baseURL}/`)).toEqual([]);

  const { aoi, values } = await band0(page);
  expect(aoi).toEqual({ epsg: 32617, gt: [west.x0, 10, 0, west.y1, 0, -10], width: 64, height: N });
  const ref = refChip();
  const want = Array.from({ length: N * 64 }, (_, i) => ref[Math.floor(i / 64) * N + (i % 64)]!);
  expect(firstDiff(values.map((v) => v ?? NaN), want)).toBe(-1);

  const centre = toLonLat(32617, west.x0 + 320, west.y1 - 640);
  await jumpTo(page, centre, 15);
  const p = await toScreen(page, centre);
  expect(isBackground(await pixelAt(page, p))).toBe(false);
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();
  await page.locator("#aef-preview").uncheck();
  expect(isBackground(await pixelAt(page, p))).toBe(true);
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();
  await expect(page.locator("#train")).toBeDisabled();
  await expect(page.locator("#classify")).toBeDisabled();
  expect(network(log, `${baseURL}/`)).toEqual([]);
});

test("opening a file after a fetch replaces the fetched data and discards its cache", async ({ page }) => {
  await serveAef(page);
  await openApp(page);
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  expect(await cacheFiles(page)).not.toBeNull();
  await page.setInputFiles("#open-aef", westFile());
  await expect(message(page)).toHaveText("AlphaEarth file opened.");
  expect(await cacheFiles(page)).toBeNull();
  expect((await band0(page)).aoi.width).toBe(64);
});

test("Open AlphaEarth file refuses a raster that isn't AlphaEarth-encoded", async ({ page }) => {
  await openApp(page);
  await page.setInputFiles("#open-aef", rgbFixture());
  await expect(message(page)).toHaveText(new AefFileError().message);
  expect(await page.evaluate(() => (window as any).__geoapp.aef())).toBeNull();
  await expect(page.getByText(ATTRIBUTION)).toBeHidden();
});

test("Open GeoTIFF refuses an AlphaEarth file, so it is never labelled", async ({ page }) => {
  await openApp(page);
  await openRaster(page, westFile());
  await expect(message(page)).toHaveText(MESSAGES.rasterIsAef);
  expect(await page.evaluate(() => Boolean((window as any).__geoapp.map.getSource("preview")))).toBe(false);
  await page.click("#train");
  await expect(message(page)).toHaveText("Open a raster first.");
});
