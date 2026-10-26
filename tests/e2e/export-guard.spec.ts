import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { readFile } from "node:fs/promises";
import { drawPolygon, message, openApp, openRaster, rgbFixture, tiff, toScreen, type LngLat } from "./helpers";

// Tester: checkClassify before the sink opens, the sink abort path, and the 2..255 class limit
// (criteria 9, 11 via the UI; reviewer fixes 2 and 3).

const rect = async (page: Page, [w, s, e, n]: number[]) =>
  Promise.all(([[w, n], [e, n], [e, s], [w, s]] as LngLat[]).map((p) => toScreen(page, p)));

async function trainTwoClasses(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await drawPolygon(page, await rect(page, [11, 43, 13, 46]), "left");
  await drawPolygon(page, await rect(page, [17, 43, 19, 46]), "right");
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
});

/** n tiny labelled polygons inside rgbFixture, added through terra-draw, one class each. */
async function addClasses(page: Page, n: number) {
  await page.evaluate((n) => {
    const { draw } = (window as any).__geoapp;
    const fs = [];
    for (let i = 0; i < n; i++) {
      const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
      const w = r6(10.2 + (i % 16) * 0.6), s = r6(40.2 + Math.floor(i / 16) * 0.6), e = r6(w + 0.03), nn = r6(s + 0.03);
      fs.push({ type: "Feature", properties: { mode: "polygon", className: `c${i}` },
        geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, nn], [w, nn], [w, s]]] } });
    }
    const res = draw.addFeatures(fs);
    if (res.some((r: any) => !r.valid)) throw new Error(`addFeatures rejected a polygon: ${JSON.stringify(res.find((r: any) => !r.valid))}`);
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
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 255 classes\.$/, { timeout: 60_000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.click("#classify")]);
    await expect(message(page)).toHaveText("Export complete.");
    const buf = await readFile((await dl.path())!);
    const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).getImage();
    const [px] = (await img.readRasters()) as unknown as Uint8Array[];
    expect(px!.includes(255)).toBe(false); // no nodata in the fixture
  });

  test("256 classes are refused with a message naming the limit, and no model is kept", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await addClasses(page, 256);
    await page.click("#train");
    await expect(message(page)).toHaveText(/255 classes/);
    await expect(message(page)).toHaveText(/256/);
    await page.click("#save-model");
    await expect(message(page)).toHaveText("Train or load a model first.");
  });

  test("one class is refused before training", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await addClasses(page, 1);
    await page.click("#train");
    await expect(message(page)).toHaveText("Draw polygons for at least two classes.");
  });
});
