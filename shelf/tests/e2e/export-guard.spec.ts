import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { readFile } from "node:fs/promises";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, message, openApp, openRaster, paintTwoClasses, rgbFixture, stroke, tiff, toScreen } from "./helpers";

// Tester: checkClassify before the sink opens, the sink abort path, and the 2..255 class limit
// (criteria 9, 11 via the UI; reviewer fixes 2 and 3). Labels come from spec 003's brush.

async function trainTwoClasses(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintTwoClasses(page);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
}

/** Same footprint as rgbFixture, one band. */
const oneBand = () => tiff("one.tif", 1000, 1000, 1, (_b, c) => c, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] });

/** OPFS sink path, with counters on the OPFS directory and writable stream. */
async function opfsWithSpies(page: Page) {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const w = window as any;
    w.__spy = { getDirectory: 0, writes: 0, aborts: 0, failAt: Infinity, mode: "native" };
    const getDirectory = navigator.storage.getDirectory.bind(navigator.storage);
    navigator.storage.getDirectory = () => { w.__spy.getDirectory++; return getDirectory(); };
    const proto = (window as any).FileSystemWritableFileStream.prototype;
    const write = proto.write;
    const abort = proto.abort;
    proto.write = function (this: unknown, d: unknown) {
      const n = ++w.__spy.writes;
      if (n !== w.__spy.failAt) return write.call(this, d);
      // "native": a real failed write, which errors the stream; "reject": the call fails, stream stays open
      return w.__spy.mode === "native" ? write.call(this, { type: "write" }) : Promise.reject(new Error("simulated write failure"));
    };
    proto.abort = function (this: unknown, r: unknown) { w.__spy.aborts++; return abort.call(this, r); };
  });
}

const spy = (page: Page) => page.evaluate(() => ({ ...(window as any).__spy }));
const opfsNames = (page: Page) => page.evaluate(async () => {
  const names: string[] = [];
  for await (const k of (await navigator.storage.getDirectory() as any).keys()) names.push(k);
  return names;
});

test.describe("classify export guard (criteria 9, 11, tester)", () => {
  test("a model that no longer fits the open raster is rejected before the Save dialog opens", async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__picker = 0;
      (window as any).showSaveFilePicker = async () => { (window as any).__picker++; throw new DOMException("cancelled", "AbortError"); };
    });
    await openApp(page);
    await trainTwoClasses(page);
    page.on("dialog", (d) => void d.accept()); // spec 003: opening another raster discards the labels
    await openRaster(page, oneBand());
    await expect(message(page)).toHaveText("Raster opened.");
    await page.click("#classify");
    await expect(message(page)).toHaveText(/^Invalid model: bands\[1\]/);
    expect(await page.evaluate(() => (window as any).__picker)).toBe(0);
  });

  test("OPFS path: a model that no longer fits opens no OPFS file and downloads nothing", async ({ page }) => {
    await opfsWithSpies(page);
    await openApp(page);
    await trainTwoClasses(page);
    page.on("dialog", (d) => void d.accept()); // spec 003: opening another raster discards the labels
    await openRaster(page, oneBand());
    await expect(message(page)).toHaveText("Raster opened.");
    let downloads = 0;
    page.on("download", () => downloads++);
    await page.click("#classify");
    await expect(message(page)).toHaveText(/^Invalid model: bands\[1\]/);
    await page.waitForTimeout(300);
    expect((await spy(page)).getDirectory).toBe(0);
    expect(await opfsNames(page)).toEqual([]);
    expect(downloads).toBe(0);
  });

  for (const mode of ["native", "reject"] as const) {
    test(`OPFS path: a ${mode === "native" ? "failed native" : "rejected"} write mid-export aborts, removes the file, downloads nothing, and a retry exports`, async ({ page }) => {
      await opfsWithSpies(page);
      await openApp(page);
      await trainTwoClasses(page);
      await page.evaluate((mode) => { Object.assign((window as any).__spy, { failAt: 3, mode }); }, mode);
      let downloads = 0;
      page.on("download", () => downloads++);
      await page.click("#classify");
      await expect(message(page)).not.toHaveText(/^(Trained on .*|Classifying\.\.\.)$/);
      await expect(message(page)).not.toHaveText("Export complete.");
      await expect(message(page)).toHaveText(mode === "native" ? /'write' on 'FileSystemWritableFileStream'/ : "simulated write failure");
      const s = await spy(page);
      expect(s.aborts).toBe(1);
      expect(s.writes).toBe(3); // nothing written after the failure
      await page.waitForTimeout(300);
      expect(downloads).toBe(0);
      expect(await opfsNames(page)).toEqual([]);

      await page.evaluate(() => { (window as any).__spy.failAt = Infinity; });
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#classify")]);
      await expect(message(page)).toHaveText("Export complete.");
      const buf = await readFile((await dl.path())!);
      const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).getImage();
      expect([img.getWidth(), img.getHeight()]).toEqual([1000, 1000]);
    });
  }

  test("OPFS path: if cleanup after a failed write also fails, the user still sees the write error", async ({ page }) => {
    await opfsWithSpies(page);
    await page.addInitScript(() => {
      (window as any).FileSystemDirectoryHandle.prototype.removeEntry = () => Promise.reject(new Error("simulated removeEntry failure"));
    });
    await openApp(page);
    await trainTwoClasses(page);
    await page.evaluate(() => { Object.assign((window as any).__spy, { failAt: 3, mode: "reject" }); });
    await page.click("#classify");
    await expect(message(page)).not.toHaveText(/^(Trained on .*|Classifying\.\.\.)$/);
    await expect(message(page)).toHaveText("simulated write failure");
    expect((await spy(page)).aborts).toBe(1);
  });
});

/** Add classes up to n, then label one pixel of each through the e2e hook (rgbFixture has no nodata). */
async function addClasses(page: Page, n: number) {
  for (let i = 2; i < n; i++) await page.click("#class-add");
  await expect(page.locator("#classes li")).toHaveCount(n);
  await page.evaluate((n) => {
    const t = new Uint8Array(256 * 256);
    for (let v = 1; v <= n; v++) t[(v - 1) * 37] = v;
    (window as any).__geoapp.labels.store.tiles.set("0,0", t);
  }, n);
}

test.describe("class limit 2..255 through the UI (criteria 6, 11, tester)", () => {
  test("255 classes train and export, and no pixel is written as 255 (nodata)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await addClasses(page, 255);
    await page.click("#train");
    await expect(message(page)).toHaveText("Trained on 255 pixels, 255 classes.", { timeout: 60_000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.click("#classify")]);
    await expect(message(page)).toHaveText("Export complete.");
    const buf = await readFile((await dl.path())!);
    const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).getImage();
    const [px] = (await img.readRasters()) as unknown as Uint8Array[];
    expect(px!.includes(255)).toBe(false); // no nodata in the fixture
  });

  // "256 classes are refused" is gone: spec 003's Add is disabled at 255 classes (brush-panel.spec.ts).

  test("one painted class is refused before training", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 6);
    const a = await toScreen(page, [12.005, 45.005]);
    await stroke(page, [a, { x: a.x + 40, y: a.y }]);
    await page.click("#train");
    await expect(message(page)).toHaveText(MESSAGES.paintTwo);
  });
});
