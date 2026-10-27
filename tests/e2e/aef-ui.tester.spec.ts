import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { ATTRIBUTION, cacheFiles, chip, drawArea, fetchChip, HOST, logRequests, lonLatBox, serveAef } from "./aef";
import { chipMismatches, files64, holdCogs, quiet, westFile } from "./aefTester";
import { collectErrors, message, openApp, openRaster, rgbFixture } from "./helpers";

// Tester e2e for spec 002's UI: opening a file during a fetch, and the Train/Classify rule (criteria 11, 12; Scope).
// The area tool is in aef-area.tester.spec.ts; the year picker and Fetch states in aef-years.tester.spec.ts.
const FIX = "tests/fixtures/aef";
const REF = readFileSync(`${FIX}/ref_chip.i8`);

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
