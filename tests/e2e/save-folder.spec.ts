import { expect, test, type Page } from "@playwright/test";
import { anotherRaster, message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";

// Spec 050 criteria 3-5: on Chromium the open picker replaces the input's chooser, and Export's Save dialog starts in the open raster's folder.

type Next = "A" | "B" | "bad" | "abort";

/** Before page scripts run: fake both pickers. The open fake returns __pick.next's handle and records the user activation; the save fake records its options and cancels. */
const fakePickers = (page: Page) => page.addInitScript(() => {
  const g = (window as any).__pick = { next: "A", handles: {} as Record<string, unknown>, active: [] as boolean[], saves: [] as string[] };
  (window as any).showOpenFilePicker = () => {
    g.active.push(navigator.userActivation.isActive);
    if (g.next === "abort") return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
    return Promise.resolve([g.handles[g.next]]);
  };
  (window as any).showSaveFilePicker = (o: { startIn?: unknown }) => {
    // the held handle's name by identity; "none" with no startIn key
    g.saves.push("startIn" in o ? Object.keys(g.handles).find((k) => g.handles[k] === o.startIn) ?? "other" : "none");
    return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
  };
});

/** Makes handles A (rgbFixture), B (another raster) and bad (not a TIFF) in the page. */
async function makeHandles(page: Page) {
  const files = { A: rgbFixture(), B: anotherRaster("b.tif"), bad: { name: "notes.tif", buffer: Buffer.from("not a tiff") } };
  for (const [key, f] of Object.entries(files)) {
    await page.evaluate(([key, name, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: "image/tiff" });
      (window as any).__pick.handles[key] = { kind: "file", name, getFile: () => Promise.resolve(file) };
    }, [key, f.name, f.buffer.toString("base64")] as const);
  }
}

const pick = (page: Page, next: Next) => page.evaluate((n) => { (window as any).__pick.next = n; }, next);
const opener = (page: Page) => page.locator("label.file", { has: page.locator("#open-raster") });

/** Clicks Export labels and returns what the save fake saw as startIn. */
async function exportStartIn(page: Page): Promise<string> {
  const n = await page.evaluate(() => (window as any).__pick.saves.length as number);
  await expect(page.locator("#export-labels")).toBeEnabled();
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__pick.saves.length)).toBe(n + 1);
  await expect(page.locator("#export-labels")).toBeEnabled();
  return page.evaluate(() => (window as any).__pick.saves.at(-1) as string);
}

async function setup(page: Page) {
  await fakePickers(page);
  await openApp(page);
  await makeHandles(page);
}

/** Opens A through the picker by clicking the Open GeoTIFF label; fails on a native chooser. */
async function openA(page: Page) {
  let chooser = false;
  page.on("filechooser", () => { chooser = true; });
  await pick(page, "A");
  await opener(page).click();
  await expect(message(page)).toHaveText("Raster opened.");
  expect(chooser).toBe(false);
}

test("criterion 3: Open GeoTIFF opens through the picker within the click, and Export starts in A's folder", async ({ page }) => {
  await setup(page);
  await openA(page);
  expect(await page.evaluate(() => (window as any).__pick.active)).toEqual([true]);
  await expect(page.locator("#raster-info")).toContainText("rgb4326.tif");
  expect(await exportStartIn(page)).toBe("A");
});

test("criterion 4: after A, picking B gives B", async ({ page }) => {
  await setup(page);
  await openA(page);
  await pick(page, "B");
  await page.click("#open-raster"); // a click on the input itself
  await expect(page.locator("#raster-info")).toContainText("b.tif");
  await expect(message(page)).toHaveText("Raster opened.");
  expect(await exportStartIn(page)).toBe("B");
});

test("criterion 4: after A, an open through the input gives no startIn", async ({ page }) => {
  await setup(page);
  await openA(page);
  await openRaster(page, anotherRaster("c.tif"));
  await expect(page.locator("#raster-info")).toContainText("c.tif");
  await expect(message(page)).toHaveText("Raster opened.");
  expect(await exportStartIn(page)).toBe("none");
});

test("criterion 4: after A, picking B but cancelling the close question gives A", async ({ page }) => {
  await setup(page);
  await openA(page);
  await paintMode(page);
  await paintTwoClasses(page);
  const asked: string[] = [];
  page.once("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await pick(page, "B");
  await opener(page).click();
  await expect.poll(() => asked.length).toBe(1); // cancelled: the open stops as confirm returns (spec 072: no fixed wait)
  await expect(page.locator("#raster-info")).toContainText("rgb4326.tif");
  expect(await exportStartIn(page)).toBe("A");
});

test("criterion 4: after A, a picked file that fails to open gives A", async ({ page }) => {
  await setup(page);
  await openA(page);
  await pick(page, "bad");
  await opener(page).click();
  await expect(message(page)).toHaveClass(/\berror\b/);
  await expect(page.locator("#raster-info")).toContainText("rgb4326.tif");
  expect(await exportStartIn(page)).toBe("A");
});

test("criterion 4: after A, a cancelled picker gives A and shows no message", async ({ page }) => {
  await setup(page);
  await openA(page);
  await pick(page, "abort");
  await opener(page).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pick.active.length)).toBe(2);
  await page.waitForTimeout(300);
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(message(page)).not.toHaveClass(/\berror\b/);
  expect(await exportStartIn(page)).toBe("A");
});

test("criterion 5: without showOpenFilePicker, Open GeoTIFF fires the native chooser and opens as before", async ({ page }) => {
  await page.addInitScript(() => { delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await opener(page).click();
  await (await chooser).setFiles(rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
});
