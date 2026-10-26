import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { AefEntry } from "../../src/core/aef";
import { MESSAGES } from "../../src/ui/messages";
import { ATTRIBUTION, cacheFiles, chip, chipBox, chipCentre, cogRequests, drawArea, drawSmallArea, fetchChip, HOST, logRequests, lonLatBox, serveAef } from "./aef";
import { chipMismatches, holdCogs, quiet, serveYears } from "./aefTester";
import { clickAt, collectErrors, drawPolygon, jumpTo, message, moveTo, openApp, openRaster, rgbFixture, toScreen, type LngLat } from "./helpers";

// Tester e2e for spec 002's UI: the area tool, the year picker and Fetch states, concurrent
// fetches and file opens, and the Train/Classify rule (criteria 3, 11, 12, 13, 14; Scope).
const FIX = "tests/fixtures/aef";
const REF = readFileSync(`${FIX}/ref_chip.i8`);
const west = (JSON.parse(readFileSync(`${FIX}/aef-index/2021/32617.json`, "utf8")) as AefEntry[])[0]!;
const westFile = () => ({ name: "west.tiff", mimeType: "image/tiff", buffer: readFileSync(`${FIX}/cogs/${west.path}`) });
const areas = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().filter((f: any) => f.properties.mode === "rectangle").length);
const rectIds = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().filter((f: any) => f.properties.mode === "rectangle").map((f: any) => f.id));
const rect = (page: Page, [w, s, e, n]: number[]) => Promise.all(([[w, n], [e, n], [e, s], [w, s]] as LngLat[]).map((p) => toScreen(page, p)));
const box = lonLatBox(chip.epsg, chipBox, 30);
const files64 = async (page: Page) => {
  const f = await cacheFiles(page);
  const aoi = await page.evaluate(() => (window as any).__geoapp.aef()?.aoi);
  if (!f || !aoi) return { ok: false, f, aoi };
  const want = Math.ceil(aoi.width / 256) * Math.ceil(aoi.height / 256) * 65536;
  return { ok: Object.keys(f).length === 64 && Object.values(f).every((s) => s === want), f, aoi };
};

test.describe("area tool (criterion 3, Scope)", () => {
  // Tester F3: a refused area is removed, so the outline on the map is always the area; the earlier one stays.
  test("a refused area after an accepted one is removed and keeps the earlier area, its info and Fetch; an accepted one clears the message", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 9); // the globe at zoom 9 keeps a 30 km box on screen
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 300));
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    await expect(page.locator("#aef-info")).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
    const info = await page.locator("#aef-info").textContent();
    const first = await rectIds(page);
    // about 30 km across: too large
    const [x, y] = [chip.x0, chip.y1];
    await drawArea(page, lonLatBox(chip.epsg, [x - 15000, y - 15000, x + 15000, y + 15000], 0));
    await expect(message(page)).toHaveText(MESSAGES.size);
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    await expect(page.locator("#aef-info")).toHaveText(info!);
    expect(await rectIds(page), "the earlier area is the one drawn").toEqual(first);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 300));
    await expect(message(page)).toHaveText("");
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    expect(await areas(page)).toBe(1);
  });

  test("Escape mid-draw keeps the earlier area, and the next area draws normally", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 13);
    await drawArea(page, box);
    const info = await page.locator("#aef-info").textContent();
    await page.click("#aef-draw");
    const a = await toScreen(page, [box[0]!, box[3]!]);
    await clickAt(page, a);
    await moveTo(page, a, { x: a.x + 60, y: a.y + 60 }, 5);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    expect(await areas(page)).toBe(1);
    await expect(page.locator("#aef-info")).toHaveText(info!);
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 10));
    expect(await areas(page)).toBe(1);
  });

  test("switching to polygon mode mid-rectangle drops the rectangle; the polygon drawn next is a label, not the area", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await page.click("#aef-draw");
    const a = await toScreen(page, [12, 47]);
    await clickAt(page, a);
    await moveTo(page, a, { x: a.x + 50, y: a.y + 50 }, 5);
    await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "only");
    expect(await areas(page)).toBe(0);
    await expect(page.locator("#polygons li")).toHaveCount(1);
    await expect(page.locator("#aef-info")).toHaveText("");
    await expect(page.locator("#aef-fetch")).toBeDisabled();
  });

  test("Enter right after the first corner (a zero-size area) neither throws nor leaves Fetch and the area info disagreeing", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 13);
    await page.click("#aef-draw");
    await clickAt(page, await toScreen(page, chipCentre));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
    expect(await areas(page)).toBeLessThanOrEqual(1);
    const info = (await page.locator("#aef-info").textContent()) ?? "";
    if (info) await expect(page.locator("#aef-fetch")).toBeEnabled();
    else await expect(page.locator("#aef-fetch")).toBeDisabled();
  });

  test("one labelled class plus the area is still one class: training is refused (single-class labels)", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await drawSmallArea(page, [15, 45.5]); // refused areas are removed (F3), so an accepted one
    await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "only");
    await page.click("#train");
    await expect(message(page)).toHaveText("Draw polygons for at least two classes.");
  });

  test("Delete in select mode removes a selected polygon and never the area", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await drawSmallArea(page, [15, 45.5]); // refused areas are removed (F3), so an accepted one
    await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "a");
    await page.click("#mode-select");
    await clickAt(page, await toScreen(page, [12, 44.5]));
    await page.keyboard.press("Delete");
    await clickAt(page, await toScreen(page, [15, 45.5])); // inside the area
    await page.keyboard.press("Delete");
    await page.waitForTimeout(150);
    expect(await areas(page)).toBe(1);
  });
});

test.describe("year picker and Fetch states (criteria 11, 13)", () => {
  test("years come from years.json with the latest selected; a year without a shard says there's nothing, with no COG request", async ({ page }) => {
    await serveAef(page);
    await serveYears(page, [2019, 2020, 2021]);
    const log = logRequests(page);
    await openApp(page);
    await expect(page.locator("#aef-fetch")).toBeDisabled(); // no area yet
    await expect(page.locator("#aef-year option")).toHaveText(["2019", "2020", "2021"]);
    await expect(page.locator("#aef-year")).toHaveValue("2021");
    await fetchChip(page, "2019");
    await expect(message(page)).toHaveText("No AlphaEarth embeddings here for 2019.");
    expect(cogRequests(log)).toEqual([]);
    await expect(page.getByText(ATTRIBUTION)).toBeHidden();
    await expect(page.locator("#aef-fetch")).toBeEnabled(); // can try another year
  });

  test("without an index, Fetch stays disabled (follow-up: no message says why)", async ({ page }) => {
    await serveAef(page);
    await page.route("**/aef-index/years.json", (r) => r.fulfill({ status: 500, body: "x" }));
    await openApp(page);
    await jumpTo(page, chipCentre, 13);
    await drawArea(page, box);
    await expect(page.locator("#aef-info")).not.toHaveText("");
    await expect(page.locator("#aef-fetch")).toBeDisabled();
  });

  test("mid-fetch, changing the year or redrawing the area keeps Fetch disabled, and the fetch finishes for the original area and year", async ({ page }) => {
    await serveAef(page);
    await serveYears(page, [2020, 2021]);
    const log = logRequests(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await expect(page.locator("#aef-fetch")).toBeDisabled();
    await expect(page.locator("#train")).toBeDisabled();
    await page.selectOption("#aef-year", "2020");
    await expect(page.locator("#aef-fetch")).toBeDisabled();
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 200));
    await expect(page.locator("#aef-fetch")).toBeDisabled();
    gate.release();
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    expect(cogRequests(log).every((r) => r.url().includes("/2021/"))).toBe(true);
    const r = await chipMismatches(page, REF);
    expect(r.mismatches).toBe(0);
    expect(r.outsideNaN).toBe(true);
    await expect(page.locator("#aef-fetch")).toBeEnabled();
  });

  test("fetching twice in a row: one cache of 64 band files, tiles equal the chip, preview and attribution shown", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    await page.locator("#aef-preview").uncheck();
    await page.click("#aef-fetch");
    await expect(message(page)).toHaveText("Downloading embeddings..."); // shown only after the old data is unloaded
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    expect((await files64(page)).ok).toBe(true);
    expect((await chipMismatches(page, REF)).mismatches).toBe(0);
    await expect(page.locator("#aef-preview")).toBeChecked();
    await expect(page.getByText(ATTRIBUTION)).toBeVisible();
  });

  // BLOCKING (tester F1): the busy state is set only after the old cache is discarded, so the second click starts a
  // second download into the same OPFS folder. In the fixture both write the same bytes and the cache ends right.
  test("a double click on Fetch after an earlier fetch runs one download, leaving one good cache", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    const before = cogRequests(log).length;
    await page.dblclick("#aef-fetch");
    const text = await quiet(page, log);
    expect(errors).toEqual([]);
    expect(text).toBe("Embeddings downloaded.");
    expect((await files64(page)).ok).toBe(true);
    expect((await chipMismatches(page, REF)).mismatches).toBe(0);
    expect(cogRequests(log).length - before, "COG requests of the second click").toBe(before);
  });
});

test.describe("opening an AlphaEarth file during a fetch (Scope: one set of AlphaEarth data at a time)", () => {
  /**
   * Start a held fetch over the chip, then try to open the west fixture file while it is held. The
   * control is disabled during a fetch (tester F1, F2); a change set by script is still made, and ignored.
   */
  async function fileDuringFetch(page: Page) {
    await serveAef(page);
    const log = logRequests(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await expect(page.locator("#open-aef")).toBeDisabled();
    await page.setInputFiles("#open-aef", westFile());
    await page.waitForTimeout(300); // long enough for the file to open, were it opened
    await expect(message(page)).toHaveText("Downloading embeddings...");
    return { log, gate };
  }

  // BLOCKING (tester F1): the file open sets the state to "loaded" while the download still runs.
  test("while a fetch is running, Fetch stays disabled even after a file has opened", async ({ page }) => {
    const { log, gate } = await fileDuringFetch(page);
    const enabled = await page.locator("#aef-fetch").isEnabled();
    gate.release();
    await quiet(page, log);
    expect(enabled, "Fetch enabled while the first download still runs").toBe(false);
  });

  // BLOCKING (tester F1): a second download into the same OPFS folder makes both fail with a raw DOMException.
  test("Fetch clicked after a file opened mid-fetch: the result is one consistent, correct set of data", async ({ page }) => {
    const errors = collectErrors(page);
    const { log, gate } = await fileDuringFetch(page);
    if (await page.locator("#aef-fetch").isDisabled()) { gate.release(); return; } // the fix: no second download can start
    await page.click("#aef-fetch");
    gate.release();
    const text = await quiet(page, log);
    expect(errors).toEqual([]);
    expect(text).toBe("Embeddings downloaded.");
    const f = await files64(page);
    expect(f.ok, JSON.stringify(f.f)).toBe(true);
    expect((await chipMismatches(page, REF)).mismatches).toBe(0);
  });

  test("whichever data ends up loaded, the message, the data and the OPFS cache agree", async ({ page }) => {
    const { log, gate } = await fileDuringFetch(page);
    gate.release();
    const text = await quiet(page, log);
    const width = await page.evaluate(() => (window as any).__geoapp.aef()?.aoi.width);
    if (width === 64) {
      expect(await cacheFiles(page), "file loaded, but a fetched cache is still on disk").toBeNull();
      expect(text).toBe("AlphaEarth file opened.");
    } else {
      expect(text).toBe("Embeddings downloaded.");
      expect((await files64(page)).ok).toBe(true);
      expect((await chipMismatches(page, REF)).mismatches).toBe(0);
    }
    await expect(page.getByText(ATTRIBUTION)).toBeVisible();
  });

  // Tester F2, resolved by F1: a file can't be opened during a fetch, so the download never silently replaces it.
  test("the open control is disabled during a fetch: no file is opened, and the fetched data is what is left loaded", async ({ page }) => {
    const { log, gate } = await fileDuringFetch(page);
    expect(await page.evaluate(() => (window as any).__geoapp.aef())).toBeNull();
    gate.release();
    const text = await quiet(page, log);
    expect(text).toBe("Embeddings downloaded.");
    expect(await page.evaluate(() => (window as any).__geoapp.aef()?.aoi.width)).not.toBe(64);
    expect((await chipMismatches(page, REF)).mismatches).toBe(0);
    await expect(page.locator("#open-aef")).toBeEnabled();
  });
});

test.describe("Train and Classify while AlphaEarth is used (criteria 11, 12)", () => {
  test("enabled before any AlphaEarth use (spec 001); a refused AlphaEarth file changes nothing", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#train")).toBeEnabled();
    await page.setInputFiles("#open-aef", rgbFixture());
    await expect(message(page)).not.toHaveText("");
    await expect(page.locator("#train")).toBeEnabled();
    await page.click("#train");
    await expect(message(page)).toHaveText("Open a raster first.");
  });

  test("disabled during a fetch, after one with no entries, and after Open GeoTIFF refuses an AlphaEarth file; enabled once local imagery opens", async ({ page }) => {
    await serveAef(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await expect(page.locator("#train")).toBeDisabled();
    await expect(page.locator("#classify")).toBeDisabled();
    gate.release();
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    // no entries (criterion 13)
    const [x0, y0, x1, y1] = [chip.x0 + 1290, chip.y1 - 500, chip.x0 + 1390, chip.y1];
    await drawArea(page, lonLatBox(chip.epsg, [x0, y0, x1, y1], 0));
    await page.click("#aef-fetch");
    await expect(message(page)).toHaveText("No AlphaEarth embeddings here for 2021.");
    await expect(page.locator("#train")).toBeDisabled();
    await expect(page.locator("#classify")).toBeDisabled();
    await openRaster(page, westFile());
    await expect(message(page)).toHaveText(MESSAGES.rasterIsAef);
    await expect(page.locator("#train")).toBeDisabled();
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(page.locator("#train")).toBeEnabled();
    await expect(page.locator("#classify")).toBeEnabled();
  });

  test("after a failed fetch the earlier data is gone too: no preview, no attribution, Train disabled", async ({ page }) => {
    let fail = false;
    await serveAef(page, () => (fail ? 500 : undefined));
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    fail = true;
    await page.click("#aef-fetch");
    await expect(message(page)).toHaveText(`Couldn't download embeddings from ${HOST}.`);
    expect(await cacheFiles(page)).toBeNull();
    await expect(page.getByText(ATTRIBUTION)).toBeHidden();
    await expect(page.locator("#aef-preview")).toBeDisabled();
    await expect(page.locator("#train")).toBeDisabled();
  });
});
