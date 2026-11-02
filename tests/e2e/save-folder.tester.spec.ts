import { expect, test, type Page } from "@playwright/test";
import { anotherRaster, collectErrors, message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";

// Spec 050, tester: edges around the open picker and the folder handle Export's Save dialog starts in.

type Next = "A" | "B" | "bad" | "gone" | "abort" | "security" | "empty" | "hold";

/** Fakes both pickers. The save fake records startIn by handle key and writes to memory, so the export completes. */
const fakePickers = (page: Page) => page.addInitScript(() => {
  const g = (window as any).__pick = { next: "A", handles: {} as Record<string, unknown>, active: [] as boolean[], saves: [] as string[],
    saveOpts: [] as Record<string, unknown>[], bytes: 0, release: null as null | ((k: string) => void) };
  (window as any).showOpenFilePicker = () => {
    g.active.push(navigator.userActivation.isActive);
    if (g.next === "abort") return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
    if (g.next === "security") return Promise.reject(new DOMException("Must be handling a user gesture to show a file picker.", "SecurityError"));
    if (g.next === "empty") return Promise.resolve([]);
    if (g.next === "hold") return new Promise((r) => { g.release = (k: string) => r([g.handles[k]]); });
    return Promise.resolve([g.handles[g.next]]);
  };
  (window as any).showSaveFilePicker = (o: Record<string, unknown>) => {
    g.saveOpts.push(o);
    g.saves.push("startIn" in o ? Object.keys(g.handles).find((k) => g.handles[k] === o.startIn) ?? "other" : "none");
    return Promise.resolve({ createWritable: () => Promise.resolve({
      write: (d: Uint8Array) => { g.bytes += d.byteLength; return Promise.resolve(); },
      close: () => Promise.resolve(), abort: () => Promise.resolve() }) });
  };
});

/** Handles A, B, bad (not a TIFF) and gone (getFile rejects as a moved or deleted file does). */
async function makeHandles(page: Page) {
  const files = { A: rgbFixture(), B: anotherRaster("b.tif"), bad: { name: "notes.tif", buffer: Buffer.from("not a tiff") } };
  for (const [key, f] of Object.entries(files)) {
    await page.evaluate(([key, name, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: "image/tiff" });
      (window as any).__pick.handles[key] = { kind: "file", name, getFile: () => Promise.resolve(file) };
    }, [key, f.name, f.buffer.toString("base64")] as const);
  }
  await page.evaluate(() => {
    (window as any).__pick.handles.gone = { kind: "file", name: "moved.tif",
      getFile: () => Promise.reject(new DOMException("A requested file or directory could not be found.", "NotFoundError")) };
  });
}

const pick = (page: Page, next: Next) => page.evaluate((n) => { (window as any).__pick.next = n; }, next);
const opener = (page: Page) => page.locator("label.file", { has: page.locator("#open-raster") });
const pickCalls = (page: Page) => page.evaluate(() => (window as any).__pick.active.length as number);

/** Clicks Export labels, waits for it to finish, and returns the save fake's startIn key. */
async function exportStartIn(page: Page): Promise<string> {
  const n = await page.evaluate(() => (window as any).__pick.saves.length as number);
  await expect(page.locator("#export-labels")).toBeEnabled();
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__pick.saves.length)).toBe(n + 1);
  await expect(message(page)).toHaveText("Labels exported.");
  return page.evaluate(() => (window as any).__pick.saves.at(-1) as string);
}

let chooser = false;
async function setup(page: Page) {
  chooser = false;
  page.on("filechooser", () => { chooser = true; });
  await fakePickers(page);
  await openApp(page);
  await makeHandles(page);
}

async function openA(page: Page) {
  await pick(page, "A");
  await opener(page).click();
  await expect(message(page)).toHaveText("Raster opened.");
}

test("criteria 3 and 6 (automatable part): a completed export passes the opened handle itself as startIn, with labels.tif and no id", async ({ page }) => {
  await setup(page);
  await openA(page);
  await paintMode(page);
  await paintTwoClasses(page);
  expect(await exportStartIn(page)).toBe("A");
  const o = await page.evaluate(() => {
    const g = (window as any).__pick;
    const opts = g.saveOpts.at(-1);
    return { same: opts.startIn === g.handles.A, name: opts.suggestedName, id: "id" in opts, bytes: g.bytes };
  });
  expect(o).toEqual({ same: true, name: "labels.tif", id: false, bytes: expect.any(Number) });
  expect(o.bytes).toBeGreaterThan(0);
  expect(chooser).toBe(false);
});

test("keyboard: Space and Enter on the focused Open GeoTIFF input open through the picker, with user activation and no native chooser", async ({ page }) => {
  await setup(page);
  await page.focus("#open-raster");
  await pick(page, "A");
  await page.keyboard.press("Space");
  await expect(message(page)).toHaveText("Raster opened.");
  await pick(page, "B");
  await page.focus("#open-raster");
  await page.keyboard.press("Enter");
  await expect(page.locator("#raster-info")).toContainText("b.tif");
  expect(await page.evaluate(() => (window as any).__pick.active)).toEqual([true, true]);
  expect(chooser).toBe(false);
  expect(await exportStartIn(page)).toBe("B");
});

test("after A, a picker SecurityError shows an error, raises no uncaught error, and keeps A", async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page);
  await openA(page);
  await pick(page, "security");
  await opener(page).click();
  await expect(message(page)).toHaveClass(/\berror\b/);
  await expect(page.locator("#raster-info")).toContainText("rgb4326.tif");
  expect(await exportStartIn(page)).toBe("A");
  expect(errors).toEqual([]);
});

test("after A, a picked file that was moved (getFile rejects) shows an error and keeps A", async ({ page }) => {
  await setup(page);
  await openA(page);
  await pick(page, "gone");
  await opener(page).click();
  await expect(message(page)).toHaveClass(/\berror\b/);
  await expect(page.locator("#raster-info")).toContainText("rgb4326.tif");
  expect(await exportStartIn(page)).toBe("A");
});

test("after A, a picker that resolves with no handle does nothing and keeps A", async ({ page }) => {
  await setup(page);
  await openA(page);
  await pick(page, "empty");
  await opener(page).click();
  await expect.poll(() => pickCalls(page)).toBe(2);
  await page.waitForTimeout(300);
  await expect(message(page)).toHaveText("Raster opened.");
  expect(await exportStartIn(page)).toBe("A");
});

test("after A, a non-TIFF that fails to open through the input keeps A", async ({ page }) => {
  await setup(page);
  await openA(page);
  await openRaster(page, { name: "notes.tif", buffer: Buffer.from("not a tiff"), mimeType: "image/tiff" } as any);
  await expect(message(page)).toHaveClass(/\berror\b/);
  await expect(page.locator("#raster-info")).toContainText("rgb4326.tif");
  expect(await exportStartIn(page)).toBe("A");
});

test("after A, cancelling the close question for an input open keeps A", async ({ page }) => {
  await setup(page);
  await openA(page);
  await paintMode(page);
  await paintTwoClasses(page);
  page.once("dialog", (d) => { void d.dismiss(); });
  await openRaster(page, anotherRaster("c.tif"));
  await page.waitForTimeout(500);
  await expect(page.locator("#raster-info")).toContainText("rgb4326.tif");
  expect(await exportStartIn(page)).toBe("A");
});

test("an input open, then a picked B, gives B (null back to a handle)", async ({ page }) => {
  await setup(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  expect(await exportStartIn(page)).toBe("none");
  await pick(page, "B");
  await opener(page).click();
  await expect(page.locator("#raster-info")).toContainText("b.tif");
  expect(await exportStartIn(page)).toBe("B");
});

test("a picked open that resolves after a newer input open neither replaces the raster nor sets the folder", async ({ page }) => {
  await setup(page);
  await pick(page, "hold");
  await opener(page).click();
  await expect.poll(() => pickCalls(page)).toBe(1);
  await openRaster(page, anotherRaster("c.tif"));
  await expect(page.locator("#raster-info")).toContainText("c.tif");
  await page.evaluate(() => (window as any).__pick.release("A"));
  await page.waitForTimeout(800);
  await expect(page.locator("#raster-info")).toContainText("c.tif");
  expect(await exportStartIn(page)).toBe("none");
});
