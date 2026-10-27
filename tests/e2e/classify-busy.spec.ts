import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { readFile } from "node:fs/promises";
import { collectErrors, message, openApp, openRaster, paintTwoClasses, rgbFixture } from "./helpers";

// "Classify and export" is disabled from the click until its run ends (success, failure, or a
// cancelled Save dialog), so two exports never write the same OPFS classified.tif at once.

async function trainTwoClasses(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintTwoClasses(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
}

/** OPFS sink path; the first write waits for `__spy.release(fail)`, and opens, writes and closes are counted. */
async function heldOpfs(page: Page) {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const w = window as any;
    let release!: (fail?: boolean) => void;
    const gate = new Promise<boolean | undefined>((r) => { release = r; });
    w.__spy = { getDirectory: 0, getFileHandle: 0, writes: 0, closes: 0, held: false, release };
    const getDirectory = navigator.storage.getDirectory.bind(navigator.storage);
    navigator.storage.getDirectory = () => { w.__spy.getDirectory++; return getDirectory(); };
    const dir = w.FileSystemDirectoryHandle.prototype;
    const getFileHandle = dir.getFileHandle;
    dir.getFileHandle = function (this: unknown, ...a: unknown[]) { w.__spy.getFileHandle++; return getFileHandle.apply(this, a); };
    const proto = w.FileSystemWritableFileStream.prototype;
    const write = proto.write, close = proto.close;
    proto.write = async function (this: unknown, d: unknown) {
      if (++w.__spy.writes === 1) {
        w.__spy.held = true;
        if (await gate) throw new Error("simulated write failure");
      }
      return write.call(this, d);
    };
    proto.close = function (this: unknown) { w.__spy.closes++; return close.call(this); };
  });
}

const spy = (page: Page) => page.evaluate(() => { const s = { ...(window as any).__spy }; delete s.release; return s; });
const opfsNames = (page: Page) => page.evaluate(async () => {
  const names: string[] = [];
  for await (const k of (await navigator.storage.getDirectory() as any).keys()) names.push(k);
  return names;
});
const classifyButton = (page: Page) => page.locator("#classify");

test.describe("Classify and export runs one at a time", () => {
  test("a second click during a held export starts nothing; one OPFS file is written and downloaded", async ({ page }) => {
    const errors = collectErrors(page);
    await heldOpfs(page);
    await openApp(page);
    await trainTwoClasses(page);
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    const first = page.waitForEvent("download");
    await page.click("#classify");
    await expect.poll(async () => (await spy(page)).held).toBe(true);
    await expect(classifyButton(page)).toBeDisabled();
    await expect(message(page)).toHaveText("Classifying...");
    const opened = await spy(page);
    // a scripted click on the disabled button, then one on a button forced enabled: both ignored
    await page.evaluate(() => (document.getElementById("classify") as HTMLButtonElement).click());
    await page.evaluate(() => {
      const b = document.getElementById("classify") as HTMLButtonElement;
      b.disabled = false;
      b.click();
      b.disabled = true;
    });
    await page.waitForTimeout(300);
    const s = await spy(page);
    expect([s.getDirectory, s.getFileHandle, s.writes]).toEqual([opened.getDirectory, opened.getFileHandle, 1]);
    await page.evaluate(() => (window as any).__spy.release());
    const dl = await first;
    await expect(message(page)).toHaveText("Export complete.");
    await expect(classifyButton(page)).toBeEnabled();
    await page.waitForTimeout(300);
    expect(downloads).toEqual(["classified.tif"]);
    expect((await spy(page)).closes).toBe(1);
    expect(await opfsNames(page)).toEqual(["classified.tif"]);
    const buf = await readFile((await dl.path())!);
    const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).getImage();
    expect([img.getWidth(), img.getHeight()]).toEqual([1000, 1000]);
    expect(errors).toEqual([]);
  });

  test("a cancelled Save dialog enables it again", async ({ page }) => {
    await page.addInitScript(() => {
      const g = (window as any).__save = { opened: 0, cancel: null as null | (() => void) };
      (window as any).showSaveFilePicker = () => new Promise((_, rej) => {
        g.opened++;
        g.cancel = () => rej(new DOMException("The user aborted a request.", "AbortError"));
      });
    });
    await openApp(page);
    await trainTwoClasses(page);
    await page.click("#classify");
    await expect.poll(() => page.evaluate(() => (window as any).__save.opened)).toBe(1);
    await expect(classifyButton(page)).toBeDisabled();
    await page.evaluate(() => (document.getElementById("classify") as HTMLButtonElement).click());
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__save.opened)).toBe(1);
    await page.evaluate(() => (window as any).__save.cancel());
    await expect(classifyButton(page)).toBeEnabled();
    await page.click("#classify");
    await expect.poll(() => page.evaluate(() => (window as any).__save.opened)).toBe(2);
  });

  test("a failed export enables it again, and a retry exports", async ({ page }) => {
    await heldOpfs(page);
    await openApp(page);
    await trainTwoClasses(page);
    await page.click("#classify");
    await expect.poll(async () => (await spy(page)).held).toBe(true);
    await expect(classifyButton(page)).toBeDisabled();
    await page.evaluate(() => (window as any).__spy.release(true));
    await expect(message(page)).toHaveText("simulated write failure");
    await expect(classifyButton(page)).toBeEnabled();
    expect(await opfsNames(page)).toEqual([]);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#classify")]);
    await expect(message(page)).toHaveText("Export complete.");
    expect(dl.suggestedFilename()).toBe("classified.tif");
    await expect(classifyButton(page)).toBeEnabled();
  });
});
