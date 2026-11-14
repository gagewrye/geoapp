import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { message, openApp, openRaster, paintMode, paintTwoClasses, rgbFixture } from "./helpers";
import { classList, effectiveTiles, importFile, maskFile, storeTiles, tileDiff } from "./seeding";

// Spec 053 criteria 2-6: on Chromium, with the imagery's handle held, Import labels' picker starts in its folder.

type Next = "A" | "L" | "abort";

/** Spec 050's fakes; the open fake also records each call's startIn by identity ("none" with no key). */
const fakePickers = (page: Page) => page.addInitScript(() => {
  const g = (window as any).__pick = { next: "A", handles: {} as Record<string, unknown>, active: [] as boolean[], starts: [] as string[], saves: [] as string[] };
  const name = (o: { startIn?: unknown }) => ("startIn" in o ? Object.keys(g.handles).find((k) => g.handles[k] === o.startIn) ?? "other" : "none");
  (window as any).showOpenFilePicker = (o: { startIn?: unknown }) => {
    g.active.push(navigator.userActivation.isActive);
    g.starts.push(name(o));
    if (g.next === "abort") return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
    return Promise.resolve([g.handles[g.next]]);
  };
  (window as any).showSaveFilePicker = (o: { startIn?: unknown }) => {
    g.saves.push(name(o));
    return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
  };
});

/** Makes handles A (rgbFixture) and L (spec 004's mask file) in the page. */
async function makeHandles(page: Page) {
  const files = { A: rgbFixture(), L: maskFile() };
  for (const [key, f] of Object.entries(files)) {
    await page.evaluate(([key, name, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: "image/tiff" });
      (window as any).__pick.handles[key] = { kind: "file", name, getFile: () => Promise.resolve(file) };
    }, [key, f.name, f.buffer.toString("base64")] as const);
  }
}

const pick = (page: Page, next: Next) => page.evaluate((n) => { (window as any).__pick.next = n; }, next);
const picks = (page: Page) => page.evaluate(() => (window as any).__pick.starts.length as number);
const label = (page: Page, id: string) => page.locator("label.file", { has: page.locator(`#${id}`) });
const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;

/** Counts native file choosers from here on. */
function choosers(page: Page) {
  const seen = { n: 0 };
  page.on("filechooser", () => { seen.n++; });
  return seen;
}

async function setup(page: Page) {
  await fakePickers(page);
  await openApp(page);
  await makeHandles(page);
}

/** Opens A through the picker (spec 050). */
async function openA(page: Page) {
  await pick(page, "A");
  await label(page, "open-raster").click();
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
}

const result = async (page: Page) => ({ tiles: await effectiveTiles(page), stored: await storeTiles(page), list: await classList(page), said: await message(page).textContent() });

test("criterion 2: Import labels picks within the click, starting in A, and imports as setInputFiles does", async ({ page }) => {
  await setup(page);
  const seen = choosers(page);
  await openA(page);
  await pick(page, "L");
  await label(page, "import-labels").click();
  await expect(message(page)).toHaveText(seeded);
  expect(seen.n).toBe(0);
  const g = await page.evaluate(() => (window as any).__pick);
  expect(g.starts).toEqual(["none", "A"]);
  expect(g.active).toEqual([true, true]);
  const picked = await result(page);
  // the same file through spec 004's path, replacing the picked import
  page.once("dialog", (d) => { expect(d.message()).toBe(MESSAGES.replace); void d.accept(); });
  await page.evaluate(() => { document.getElementById("message")!.textContent = ""; });
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(seeded);
  expect(await result(page)).toEqual(picked);
});

test("criterion 3: a cancelled picker imports nothing and shows nothing; a dismissed replace confirm imports nothing", async ({ page }) => {
  await setup(page);
  await openA(page);
  await paintTwoClasses(page);
  const before = { labels: await effectiveTiles(page), list: await classList(page) };
  const unchanged = async () => {
    expect(tileDiff(await effectiveTiles(page), before.labels)).toEqual([]);
    expect(await classList(page)).toEqual(before.list);
    await expect(page.locator("#undo")).toBeEnabled();
    await expect(page.locator("#class-map")).toBeDisabled(); // no imported mask
  };
  await page.evaluate(() => { document.getElementById("message")!.textContent = ""; });
  await pick(page, "abort");
  const asked: string[] = [];
  page.on("dialog", (d) => { asked.push(d.message()); void d.dismiss(); });
  await label(page, "import-labels").click();
  await expect.poll(() => picks(page)).toBe(2); // the rejected picker is handled before the next evaluate (spec 072: no fixed wait)
  await expect(message(page)).toHaveText("");
  expect(asked).toEqual([]);
  await unchanged();
  await pick(page, "L");
  await page.click("#import-labels"); // a click on the input itself
  await expect.poll(() => asked).toEqual([MESSAGES.replace]); // dismissed: the import stops as confirm returns
  await expect(message(page)).toHaveText("");
  await unchanged();
});

test("criterion 4: after an import through the picker, Export still starts in A", async ({ page }) => {
  await setup(page);
  await openA(page);
  await pick(page, "L");
  await label(page, "import-labels").click();
  await expect(message(page)).toHaveText(seeded);
  await expect(page.locator("#export-labels")).toBeEnabled();
  await page.click("#export-labels");
  await expect.poll(() => page.evaluate(() => (window as any).__pick.saves)).toEqual(["A"]);
});

test("criterion 5: imagery opened through the input leaves Import labels on the native chooser", async ({ page }) => {
  await setup(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await label(page, "import-labels").click();
  await chooser;
  expect(await picks(page)).toBe(0);
});

test("criterion 5: without showOpenFilePicker, Import labels uses the native chooser", async ({ page }) => {
  await page.addInitScript(() => { delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker; });
  await openApp(page);
  const open = page.waitForEvent("filechooser", { timeout: 3000 });
  await label(page, "open-raster").click();
  await (await open).setFiles(rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await label(page, "import-labels").click();
  await (await chooser).setFiles(maskFile());
  await expect(message(page)).toHaveText(seeded);
});

test("criterion 6: with A held, Apply class map keeps the native chooser", async ({ page }) => {
  await setup(page);
  await openA(page);
  await importFile(page, maskFile()); // Apply class map needs an imported mask
  await expect(message(page)).toHaveText(seeded);
  const before = await picks(page);
  const chooser = page.waitForEvent("filechooser", { timeout: 3000 });
  await label(page, "class-map").click();
  await chooser;
  expect(await picks(page)).toBe(before);
});
