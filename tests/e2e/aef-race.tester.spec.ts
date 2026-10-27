import { expect, test, type Page } from "@playwright/test";
import { ATTRIBUTION, cacheFiles, chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, HOST, logRequests, lonLatBox, serveAef } from "./aef";
import { chipLoaded, holdCogs, quiet, westFile } from "./aefTester";
import { jumpTo, message, openApp } from "./helpers";

// Tester re-verification of F1, F2 and F7 (spec 002 Scope: one set of AlphaEarth data, one operation at a time):
// a file open and a Fetch in the same task, and failures around a file and a fetch.
const NOTE = /\(not fetched yet; the loaded data is another area\)$/;
const fetchBtn = (page: Page) => page.locator("#aef-fetch");
const openBtn = (page: Page) => page.locator("#open-aef");
const loadedWidth = (page: Page) => page.evaluate(() => (window as any).__geoapp.aef()?.aoi.width ?? null);

/** In one task, set the west file on the AlphaEarth input and dispatch its change, then (or first) click Fetch. */
function race(page: Page, fileFirst: boolean) {
  return page.evaluate(([b64, first]) => {
    const input = document.getElementById("open-aef") as HTMLInputElement;
    const btn = document.getElementById("aef-fetch") as HTMLButtonElement;
    const openIt = () => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "west.tiff", { type: "image/tiff" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // dispatchEvent, not click(): it reaches the listener even if the button is already disabled
    const clickIt = () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    if (first) { openIt(); clickIt(); } else { clickIt(); openIt(); }
    return input.value;
  }, [westFile().buffer.toString("base64"), fileFirst] as const);
}

test.describe("file open and Fetch in the same task (F1, F2)", () => {
  test("file change then Fetch click: the file opens, nothing is fetched", async ({ page }) => {
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    await race(page, true);
    const text = await quiet(page, log);
    expect(text).toBe("AlphaEarth file opened.");
    expect(cogRequests(log)).toEqual([]);
    expect(await loadedWidth(page)).toBe(64);
    expect(await cacheFiles(page)).toBeNull();
    await expect(page.locator("#aef-info")).toHaveText(NOTE); // F7: the drawn area isn't the file's grid
  });

  test("Fetch click then file change: the change is ignored and cleared, the chip is fetched", async ({ page }) => {
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    const value = await race(page, false);
    expect(value, "the ignored file is cleared from the input").toBe("");
    const text = await quiet(page, log);
    expect(text).toBe("Embeddings downloaded.");
    expect(await loadedWidth(page)).not.toBe(64);
    await chipLoaded(page);
  });

  test("two file changes in one task: the first opens, the second is ignored", async ({ page }) => {
    await openApp(page);
    await page.evaluate(([b64]) => {
      const input = document.getElementById("open-aef") as HTMLInputElement;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      for (const name of ["west.tiff", "junk.tiff"]) {
        const dt = new DataTransfer();
        dt.items.add(new File([name === "west.tiff" ? bytes : new Uint8Array(10)], name, { type: "image/tiff" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, [westFile().buffer.toString("base64")] as const);
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    expect(await loadedWidth(page)).toBe(64);
  });
});

test.describe("failures around a file and a fetch (F1, F8 accepted under criterion 12)", () => {
  test("a fetch that fails while a file is loaded: the message, nothing loaded, and the file can be opened again", async ({ page }) => {
    await serveAef(page, () => 500);
    const log = logRequests(page);
    await openApp(page);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(page.locator("#aef-info")).toHaveText(NOTE);
    await page.click("#aef-fetch");
    await expect(message(page)).toHaveText(`Couldn't download embeddings from ${HOST}.`);
    expect(await loadedWidth(page)).toBeNull();
    expect(await cacheFiles(page)).toBeNull();
    await expect(page.getByText(ATTRIBUTION)).toBeHidden();
    await expect(page.locator("#train")).toBeDisabled();
    await expect(page.locator("#aef-info")).not.toHaveText(NOTE); // nothing is loaded now
    await expect(fetchBtn(page)).toBeEnabled();
    await expect(openBtn(page)).toBeEnabled();
    await page.setInputFiles("#open-aef", []);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    expect(await loadedWidth(page)).toBe(64);
    void log;
  });

  test("a file set during a fetch that then fails is not opened afterwards", async ({ page }) => {
    let fail = false;
    await serveAef(page, () => (fail ? "network" : undefined));
    const log = logRequests(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await page.setInputFiles("#open-aef", westFile());
    fail = true;
    gate.release();
    const text = await quiet(page, log);
    expect(text).toBe(`Couldn't download embeddings from ${HOST}.`);
    expect(await loadedWidth(page)).toBeNull();
    expect(await cacheFiles(page)).toBeNull();
    await expect(openBtn(page)).toHaveValue("");
    await expect(openBtn(page)).toBeEnabled();
    await expect(fetchBtn(page)).toBeEnabled();
  });

  test("a refused file while fetched data is loaded keeps that data, its cache, attribution and Fetch", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    await page.setInputFiles("#open-aef", { name: "x.tiff", mimeType: "image/tiff", buffer: Buffer.alloc(16) });
    await expect(message(page)).not.toHaveText("Embeddings downloaded.");
    await expect(message(page)).not.toHaveText("");
    await chipLoaded(page);
    await expect(fetchBtn(page)).toBeEnabled();
    await expect(page.locator("#train")).toBeDisabled();
  });
});
