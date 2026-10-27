import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { ATTRIBUTION, chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, logRequests, lonLatBox, serveAef } from "./aef";
import { chipMismatches, files64, westFile } from "./aefTester";
import { jumpTo, message, openApp } from "./helpers";

// Tester F10: one tab at a time holds the AlphaEarth cache. The lock is released on discard (a file
// opened over fetched data, a failed fetch) and when the page unloads, so another tab can then fetch.
const REF = readFileSync("tests/fixtures/aef/ref_chip.i8");
const loadedWidth = (page: Page) => page.evaluate(() => (window as any).__geoapp.aef()?.aoi.width ?? null);

async function tabs(context: BrowserContext, fault?: Parameters<typeof serveAef>[1]): Promise<[Page, Page]> {
  const a = await context.newPage(), b = await context.newPage();
  await serveAef(a, fault);
  await serveAef(b);
  await openApp(a);
  await openApp(b);
  return [a, b];
}

/** Tab A holds the cache: tab B's fetch of the chip is refused. */
async function refusedIn(b: Page): Promise<void> {
  await fetchChip(b);
  await expect(message(b)).toHaveText(MESSAGES.aefOtherTab);
}

/** Tab B fetches the chip and has it, as 64 good band files. */
async function fetchesIn(b: Page): Promise<void> {
  await b.click("#aef-fetch");
  await expect(message(b)).toHaveText("Embeddings downloaded.");
  expect((await chipMismatches(b, REF)).mismatches).toBe(0);
  expect((await files64(b)).ok).toBe(true);
}

async function fetched(a: Page): Promise<void> {
  await fetchChip(a);
  await expect(message(a)).toHaveText("Embeddings downloaded.");
}

test("closing the tab that holds the cache lets another tab fetch", async ({ context }) => {
  const [a, b] = await tabs(context);
  await fetched(a);
  await refusedIn(b);
  await a.close();
  await fetchesIn(b);
});

test("reloading the tab that holds the cache lets another tab fetch, and the reloaded tab is then refused", async ({ context }) => {
  const [a, b] = await tabs(context);
  await fetched(a);
  await refusedIn(b);
  await a.reload();
  await openApp(a);
  await fetchesIn(b);
  await refusedIn(a);
});

test("opening a file over fetched data lets another tab fetch, and that fetch leaves the file loaded", async ({ context }) => {
  const [a, b] = await tabs(context);
  await fetched(a);
  await refusedIn(b);
  await a.setInputFiles("#open-aef", westFile());
  await expect(message(a)).toHaveText("AlphaEarth file opened.");
  await fetchesIn(b);
  expect(await loadedWidth(a)).toBe(64);
});

test("a failed fetch lets another tab fetch", async ({ context }) => {
  const [a, b] = await tabs(context, () => 500);
  await fetchChip(a);
  await expect(message(a)).toHaveText(/^Couldn't download embeddings from /);
  await fetchChip(b);
  await expect(message(b)).toHaveText("Embeddings downloaded.");
});

test("while another tab holds the cache, a file still opens, and a refused fetch leaves that file loaded and shown", async ({ context }) => {
  const [a, b] = await tabs(context);
  const lb = logRequests(b);
  await fetched(a);
  await b.setInputFiles("#open-aef", westFile());
  await expect(message(b)).toHaveText("AlphaEarth file opened.");
  await jumpTo(b, chipCentre, 15);
  await drawArea(b, lonLatBox(chip.epsg, chipBox, 30));
  await b.click("#aef-fetch");
  await expect(message(b)).toHaveText(MESSAGES.aefOtherTab);
  expect(cogRequests(lb)).toEqual([]);
  expect(await loadedWidth(b)).toBe(64);
  await expect(b.locator("#aef-preview")).toBeChecked();
  await expect(b.locator("#aef-preview")).toBeEnabled();
  await expect(b.getByText(ATTRIBUTION)).toBeVisible();
  await expect(b.locator("#aef-info")).toHaveText(/\(not fetched yet; the loaded data is another area\)$/);
  await expect(b.locator("#aef-fetch")).toBeEnabled();
  await expect(b.locator("#open-aef")).toBeEnabled();
  expect((await chipMismatches(a, REF)).mismatches, "tab A's data").toBe(0);
});
