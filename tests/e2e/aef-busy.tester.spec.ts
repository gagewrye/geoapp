import { expect, test, type Page } from "@playwright/test";
import { ATTRIBUTION, cacheFiles, chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, logRequests, lonLatBox, serveAef } from "./aef";
import { chipLoaded, holdCogs, holdRemoves, quiet, westFile } from "./aefTester";
import { collectErrors, jumpTo, message, openApp } from "./helpers";

// Tester re-verification of F1 (spec 002 Scope: one operation at a time): repeated clicks, keyboard
// activation, and clicks while a previous cache unloads. File/fetch races: aef-race.tester.spec.ts.
const fetchBtn = (page: Page) => page.locator("#aef-fetch");
const openBtn = (page: Page) => page.locator("#open-aef");
const loadedWidth = (page: Page) => page.evaluate(() => (window as any).__geoapp.aef()?.aoi.width ?? null);
const asked = (log: Parameters<typeof cogRequests>[0]) => cogRequests(log).map((r) => `${r.url()} ${r.headers().range ?? ""}`);

/** One complete fetch over the chip; returns how many COG requests it made. */
async function oneFetch(page: Page, log: Parameters<typeof cogRequests>[0]): Promise<number> {
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  return cogRequests(log).length;
}

test.describe("repeated activation of Fetch (F1)", () => {
  test("a triple-clicked first Fetch runs one download, each COG range once, and leaves the chip loaded", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    const single = await oneFetch(page, log);
    // a fresh page for the real case: the first Fetch of a session
    await page.reload();
    log.length = 0;
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    await page.click("#aef-fetch", { clickCount: 3 });
    const text = await quiet(page, log);
    expect(errors).toEqual([]);
    expect(text).toBe("Embeddings downloaded.");
    expect(cogRequests(log).length, "COG requests of a triple click").toBe(single);
    expect(new Set(asked(log)).size).toBe(single);
    await chipLoaded(page);
  });

  test("Enter and Space on a focused Fetch: the first starts one download, the rest do nothing until it ends", async ({ page }) => {
    await serveAef(page);
    const log = logRequests(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    await fetchBtn(page).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press(" ");
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await expect(fetchBtn(page)).toBeDisabled();
    await expect(openBtn(page)).toBeDisabled();
    gate.release();
    const text = await quiet(page, log);
    expect(text).toBe("Embeddings downloaded.");
    const a = asked(log);
    expect(new Set(a).size, "each COG range requested once").toBe(a.length);
    await chipLoaded(page);
  });

  test("Space alone on a focused Fetch fetches (keyboard users can fetch)", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await fetchBtn(page).focus();
    await page.keyboard.press(" ");
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    await chipLoaded(page);
  });
});

test.describe("acting while the previous cache is being unloaded (F1)", () => {
  test("clicks, keys and a file set while the old cache's delete is held start nothing; one download follows", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    const rm = await holdRemoves(page);
    const log = logRequests(page);
    await openApp(page);
    const single = await oneFetch(page, log);
    await rm.hold();
    await page.click("#aef-fetch");
    await expect.poll(() => rm.held(), { message: "the unload's delete is held" }).toBeGreaterThan(0);
    // still unloading: no download has started yet
    expect(cogRequests(log).length).toBe(single);
    await expect(fetchBtn(page)).toBeDisabled();
    await expect(openBtn(page)).toBeDisabled();
    await page.click("#aef-fetch", { force: true, clickCount: 2 });
    await fetchBtn(page).dispatchEvent("click");
    await page.keyboard.press("Enter");
    await page.setInputFiles("#open-aef", westFile());
    await expect(openBtn(page), "an ignored file is cleared from the input").toHaveValue("");
    await rm.release();
    const text = await quiet(page, log);
    expect(errors).toEqual([]);
    expect(text).toBe("Embeddings downloaded.");
    expect(cogRequests(log).length - single, "COG requests after the first fetch").toBe(single);
    expect(await loadedWidth(page)).not.toBe(64);
    await chipLoaded(page);
  });

  test("a file opened over fetched data while the old cache's delete is held: Fetch can't start, the file ends loaded, no cache left", async ({ page }) => {
    await serveAef(page);
    const rm = await holdRemoves(page);
    const log = logRequests(page);
    await openApp(page);
    const single = await oneFetch(page, log);
    await rm.hold();
    await page.setInputFiles("#open-aef", westFile());
    await expect.poll(() => rm.held()).toBeGreaterThan(0);
    await expect(fetchBtn(page)).toBeDisabled();
    await fetchBtn(page).dispatchEvent("click");
    await rm.release();
    const text = await quiet(page, log);
    expect(text).toBe("AlphaEarth file opened.");
    expect(cogRequests(log).length).toBe(single);
    expect(await loadedWidth(page)).toBe(64);
    expect(await cacheFiles(page)).toBeNull();
    await expect(page.getByText(ATTRIBUTION)).toBeVisible();
    await expect(fetchBtn(page)).toBeEnabled();
  });
});
