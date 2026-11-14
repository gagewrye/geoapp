import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { rgbFixture } from "./fixtures";
import { jumpTo, message, openApp, openRaster, paintMode, paintTwoClasses, path, stroke, toScreen } from "./helpers";
import { effectiveTiles, importFile, maskFile, saved, storeTiles, tileDiff } from "./seeding";

// Spec 076 criteria 5-8 and spec 075 criterion 6: Export writes through a folder handle and never destroys a file.

/**
 * Before page scripts run: the pickers work on the OPFS folder work/. The open picker returns work/<__f.next>; the folder
 * picker returns work/ itself; the Save dialog, if ever called, empties the chosen file before returning, as WICG says.
 * __f.failAt makes the next export's writable reject on that write; __f.quota refuses every mask copy (spec 032 noCopy).
 */
const fakeFolder = (page: Page) => page.addInitScript(() => {
  const g = (window as any).__f = { next: "", saves: 0, failAt: null as number | null, quota: false };
  const work = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("work", { create: true });
  (window as any).showOpenFilePicker = async () => [await (await work()).getFileHandle(g.next)];
  (window as any).showSaveFilePicker = async (o: { suggestedName: string }) => {
    g.saves++;
    const h = await (await work()).getFileHandle(o.suggestedName, { create: true });
    const w = await h.createWritable(); await w.close();
    return h;
  };
  (window as any).showDirectoryPicker = async () => {
    const dir = await work();
    if (g.failAt === null) return dir;
    const n = g.failAt;
    // the folder's getFileHandle wrapped: its handles' writables reject on write n (spec 076 criterion 7)
    const get = dir.getFileHandle.bind(dir);
    (dir as any).getFileHandle = async (name: string, o?: FileSystemGetFileOptions) => {
      const h = await get(name, o);
      const open = h.createWritable.bind(h);
      (h as any).createWritable = async (wo?: FileSystemCreateWritableOptions) => {
        const w = await open(wo);
        let k = 0;
        return { write: (d: unknown) => (++k >= n ? Promise.reject(new DOMException("The disk failed.", "InvalidStateError")) : w.write(d as BufferSource)),
          close: () => w.close(), abort: () => w.abort() };
      };
      return h;
    };
    return dir;
  };
  const create = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = function (this: FileSystemFileHandle, ...a) {
    // the mask copies in bases/ are named by a 16-hex-digit hash (ADR 0025)
    if (g.quota && /^[0-9a-f]{16}\.tif$/.test(this.name)) return Promise.reject(new DOMException("full", "QuotaExceededError"));
    return create.apply(this, a);
  };
});

/** Writes bytes into work/name. */
const put = (page: Page, name: string, bytes: Buffer) => page.evaluate(async ([name, b64]) => {
  const w = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("work", { create: true })).getFileHandle(name, { create: true })).createWritable();
  await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  await w.close();
}, [name, bytes.toString("base64")] as const);

/** The bytes of work/name, or null when there is none. */
const bytesOf = async (page: Page, name: string): Promise<Buffer | null> => {
  const b64 = await page.evaluate(async (name) => {
    try {
      const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("work")).getFileHandle(name)).getFile();
      const a = new Uint8Array(await f.arrayBuffer());
      let s = "";
      for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
      return btoa(s);
    } catch { return null; }
  }, name);
  return b64 === null ? null : Buffer.from(b64, "base64");
};

/** Answers dialogs in order: a string answers a prompt, true accepts, false dismisses; beforeunload is accepted. Logs each message. */
function answer(page: Page) {
  const queue: (string | boolean)[] = [], log: string[] = [];
  page.on("dialog", (d) => {
    log.push(d.message());
    if (d.type() === "beforeunload") { void d.accept(); return; }
    const a = queue.shift();
    if (a === undefined || a === false) void d.dismiss();
    else void d.accept(typeof a === "string" ? a : undefined);
  });
  return { queue, log, then: (...a: (string | boolean)[]) => { queue.push(...a); } };
}

const pick = (page: Page, name: string) => page.evaluate((n) => { (window as any).__f.next = n; }, name);
const fileLabel = (page: Page, id: string) => page.locator("label.file", { has: page.locator(`#${id}`) });
const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const exportedTo = (name: string) => new RegExp(`^Labels exported to ${name.replace(".", "\\.")} \\([\\d.]+ MB\\)\\.$`);

/** Opens rgb4326.tif from work/ through the open picker, so the app holds its handle. */
async function openPicked(page: Page) {
  await put(page, "rgb4326.tif", rgbFixture().buffer);
  await pick(page, "rgb4326.tif");
  await fileLabel(page, "open-raster").click();
  await expect(message(page)).toHaveText("Raster opened.");
}

/** Imports work/<name> through Import labels' picker. */
async function importPicked(page: Page, name: string) {
  await pick(page, name);
  await fileLabel(page, "import-labels").click();
  await expect(message(page)).toHaveText(seeded);
}

async function exportAs(page: Page) {
  await expect(page.locator("#export-labels")).toBeEnabled();
  await page.click("#export-labels");
}

test("criterion 5: export over the imported labels_merged.tif writes it whole; re-importing it gives the same tiles, and painting still works", async ({ page }) => {
  await fakeFolder(page);
  const dialogs = answer(page);
  await openApp(page);
  await put(page, "labels_merged.tif", maskFile().buffer);
  await openPicked(page);
  await importPicked(page, "labels_merged.tif");
  await paintMode(page);
  await paintTwoClasses(page);
  await saved(page);
  const before = await effectiveTiles(page);

  dialogs.then("labels_merged.tif", true);
  await exportAs(page);
  await expect(message(page)).toHaveText(exportedTo("labels_merged.tif"), { timeout: 30_000 });
  expect(dialogs.log).toContain(MESSAGES.exportReplace("labels_merged.tif"));
  dialogs.then("fresh.tif");
  await exportAs(page);
  await expect(message(page)).toHaveText(exportedTo("fresh.tif"), { timeout: 30_000 });
  const merged = (await bytesOf(page, "labels_merged.tif"))!, fresh = (await bytesOf(page, "fresh.tif"))!;
  expect(merged.length).toBeGreaterThan(1000);
  expect(merged.equals(fresh)).toBe(true); // both verified at totalBytes, and the same labels
  expect(await page.evaluate(() => (window as any).__f.saves)).toBe(0);

  // a stroke on an unedited masked tile reads the mask, now from the app's copy
  expect((await storeTiles(page)).has("0,768")).toBe(false);
  expect(before.has("0,768")).toBe(true);
  await jumpTo(page, [11.2, 41.2], 9);
  const a = await toScreen(page, [11.1, 41.2]), b = await toScreen(page, [11.3, 41.25]);
  await stroke(page, path(a, b, 6));
  await expect.poll(async () => (await storeTiles(page)).has("0,768")).toBe(true);
  await expect(message(page)).not.toHaveClass(/\berror\b/);

  dialogs.then(true); // Replace labels?
  await importPicked(page, "labels_merged.tif");
  expect(tileDiff(await effectiveTiles(page), before)).toEqual([]);
});

test("criterion 6: exporting with the imagery's file name is refused, and the imagery is unchanged", async ({ page }) => {
  await fakeFolder(page);
  const dialogs = answer(page);
  await openApp(page);
  await openPicked(page);
  await paintMode(page);
  await paintTwoClasses(page);
  dialogs.then("rgb4326.tif");
  await exportAs(page);
  await expect(message(page)).toHaveText(MESSAGES.exportImagery);
  await expect(message(page)).toHaveClass(/\berror\b/);
  expect((await bytesOf(page, "rgb4326.tif"))!.equals(rgbFixture().buffer)).toBe(true);
});

/** Opens rgb4326.tif through the input, imports the fixture mask and paints two strokes, then waits for Saved. */
async function paintedAndSaved(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(seeded);
  await paintMode(page);
  await paintTwoClasses(page);
  await saved(page);
}

test("criterion 7: a write that fails midway keeps the old labels.tif, and a reload restores the same tiles", async ({ page }) => {
  await fakeFolder(page);
  const dialogs = answer(page);
  await openApp(page);
  const old = Buffer.from("the labels from yesterday");
  await put(page, "labels.tif", old);
  await paintedAndSaved(page);
  const before = await effectiveTiles(page);

  await page.evaluate(() => { (window as any).__f.failAt = 3; }); // the header and a tile, then the third write rejects
  dialogs.then("labels.tif", true);
  await exportAs(page);
  await expect(message(page)).toHaveText(`The disk failed. ${MESSAGES.nothingOverwritten}`);
  expect((await bytesOf(page, "labels.tif"))!.equals(old)).toBe(true);
  expect(tileDiff(await effectiveTiles(page), before)).toEqual([]); // the labels and mask are unchanged; Undo is criterion 3's unit test
  await saved(page);

  await page.reload();
  await expect(page.locator("#map[data-ready=true]")).toBeVisible();
  dialogs.then(true); // restore
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Labels restored.");
  expect(tileDiff(await effectiveTiles(page), before)).toEqual([]);
});

test("spec 075 criterion 6: a good export marks the saved session exported, at or after its savedAt", async ({ page }) => {
  await fakeFolder(page);
  const dialogs = answer(page);
  await openApp(page);
  await paintedAndSaved(page);
  dialogs.then("good.tif");
  await exportAs(page);
  await expect(message(page)).toHaveText(exportedTo("good.tif"), { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("geoplatform");
    open.onsuccess = () => {
      const r = open.result.transaction("sessions").objectStore("sessions").getAll();
      r.onsuccess = () => resolve((r.result as { role?: string; savedAt: number; exportedAt?: number | null }[])
        .some((s) => (s.role ?? "current") === "current" && s.exportedAt != null && s.exportedAt >= s.savedAt));
    };
  }))).toBe(true);
});

test("criterion 8: with no copy of the mask (quota), exporting as the imported file's name is refused; another name succeeds", async ({ page }) => {
  await fakeFolder(page);
  const dialogs = answer(page);
  await openApp(page);
  await page.evaluate(() => { (window as any).__f.quota = true; });
  const mask = maskFile().buffer;
  await put(page, "labels_merged.tif", mask);
  await openPicked(page);
  await importPicked(page, "labels_merged.tif");
  dialogs.then("labels_merged.tif");
  await exportAs(page);
  await expect(message(page)).toHaveText(MESSAGES.exportMask);
  expect((await bytesOf(page, "labels_merged.tif"))!.equals(mask)).toBe(true);
  dialogs.then("other.tif");
  await exportAs(page);
  await expect(message(page)).toHaveText(exportedTo("other.tif"), { timeout: 30_000 });
});
