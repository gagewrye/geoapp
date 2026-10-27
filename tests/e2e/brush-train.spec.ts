import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { MAX_LABEL_TILES } from "../../src/core/labelStore";
import { predictTile } from "../../src/core/predict";
import { validate } from "../../src/core/validate";
import { openGeoTiff } from "../../src/io/geotiffSource";
import { writeTiff } from "../../src/io/tiffWriter";
import { MESSAGES } from "../../src/ui/messages";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, rgbFixture, selectClass, settled, stroke, tiff, toScreen, type Xy } from "./helpers";

// Spec 003 criteria 15 (train) and 17 (privacy).

async function download(page: Page, click: string): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(click)]);
  return readFile((await dl.path())!);
}
const arrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * A 257 x 256 by 2 px Uint8 strip (257 tiles) at 0.005 degrees, written with ADR 0001's tiled writer:
 * geotiff.js's writer stores the width as a 16-bit SHORT, which can't hold 65792.
 */
async function stripTiff() {
  const parts: Uint8Array[] = [];
  const geo = { GeoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326], ModelPixelScale: [0.005, 0.005, 0], ModelTiepoint: [0, 0, 0, -175, 10, 0] };
  await writeTiff({ write: async (d) => { parts.push(d.slice()); }, close: async () => {} }, 257 * 256, 2, geo,
    async (w) => new Uint8Array(w.width * w.height).fill(7));
  return { name: "strip.tif", mimeType: "image/tiff", buffer: Buffer.concat(parts) };
}

/** A mouse stroke that doesn't wait for Train to be enabled again. */
async function rawStroke(page: Page, pts: Xy[], button: "left" | "right" = "left") {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down({ button });
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up({ button });
}

/** Paint class 1 on the west half and class 2 on the east half of rgbFixture, by mouse. */
async function paintTwo(page: Page) {
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [13.005, 45.005]), b = await toScreen(page, [17.005, 44.505]);
  await stroke(page, [a, { x: a.x + 30, y: a.y + 20 }, { x: a.x + 60, y: a.y }]);
  await selectClass(page, 1);
  await stroke(page, [b, { x: b.x + 30, y: b.y - 20 }, { x: b.x + 60, y: b.y }]);
}

test.describe("train (criterion 15)", () => {
  test("after painting two classes model.classes equals the list and N is the labelled pixels; export meets spec 001 criterion 9", async ({ page }) => {
    await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
    await openApp(page);
    const fixture = rgbFixture();
    await openRaster(page, fixture);
    await expect(message(page)).toHaveText("Raster opened.");
    await page.click("#class-add"); // an unpainted class is fitted too
    await paintTwo(page);
    const n = (await labels(page)).size;
    expect(n).toBeGreaterThan(100);
    await page.click("#train");
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 3 classes.`);
    const model: unknown = JSON.parse((await download(page, "#save-model")).toString("utf8"));
    validate(model, 3);
    expect(model.classes).toEqual(["Class 1", "Class 2", "Class 3"]);

    const out = await (await fromArrayBuffer(arrayBuffer(await download(page, "#classify")))).getImage();
    await expect(message(page)).toHaveText("Export complete.");
    const input = await (await fromArrayBuffer(arrayBuffer(fixture.buffer))).getImage();
    expect([out.getWidth(), out.getHeight()]).toEqual([1000, 1000]);
    expect(out.getOrigin()).toEqual(input.getOrigin());
    expect(out.getResolution()).toEqual(input.getResolution());
    expect(out.getGeoKeys()).toEqual(input.getGeoKeys());
    expect([out.getTileWidth(), out.getTileHeight()]).toEqual([256, 256]);
    expect(out.getGDALNoData()).toBe(255);
    const src = await openGeoTiff(await fromArrayBuffer(arrayBuffer(fixture.buffer)));
    const [px] = (await out.readRasters()) as unknown as Uint8Array[];
    const want = predictTile(model, await src.readWindow(0, 0, 1000, 1000));
    expect(Buffer.from(px!).equals(Buffer.from(want))).toBe(true);
    expect(new Set(want)).toEqual(new Set([0, 1]));
  });

  test("erasing a class while Train reads: training completes on the labels as they were at the click, with no error", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintTwo(page);
    const before = await labels(page);
    expect(new Set(before.values())).toEqual(new Set([1, 2]));
    await page.evaluate(() => {
      const s = (window as any).__geoapp.imagery();
      const read = s.readWindow.bind(s);
      const g = (window as any).__gate = { reads: 0, open: null as null | (() => void) };
      const wait = new Promise<void>((r) => { g.open = r; });
      s.readWindow = async (...a: unknown[]) => { g.reads++; await wait; return read(...a); };
    });
    await page.click("#train");
    await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
    // class 2 is selected: retrace its stroke with the right button to erase all of it (erase reads
    // nothing; Train stays disabled while it runs, so this doesn't wait for it)
    const b = await toScreen(page, [17.005, 44.505]);
    await rawStroke(page, [b, { x: b.x + 30, y: b.y - 20 }, { x: b.x + 60, y: b.y }], "right");
    await expect.poll(async () => new Set((await labels(page)).values())).toEqual(new Set([1]));
    await expect(message(page)).toHaveText("Training...");
    await page.evaluate(() => (window as any).__gate.open());
    await expect(message(page)).toHaveText(`Trained on ${before.size} pixels, 2 classes.`);
    expect(errors).toEqual([]);
    await page.click("#train"); // the erase stands for the next Train
    await expect(message(page)).toHaveText(MESSAGES.paintTwo);
  });

  test("Train is disabled from the click until its run ends, and enabled again after a failed run", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintTwo(page);
    const n = (await labels(page)).size;
    await page.evaluate(() => {
      const s = (window as any).__geoapp.imagery();
      const read = s.readWindow.bind(s);
      const g = (window as any).__gate = { reads: 0, fail: null as null | (() => void) };
      s.readWindow = (...a: unknown[]) => {
        if (++g.reads > 1) return read(...a);
        return new Promise((_, rej) => { g.fail = () => rej(new Error("Read failed.")); });
      };
    });
    await page.click("#train");
    await expect(page.locator("#train")).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
    await page.evaluate(() => (window as any).__gate.fail());
    await expect(message(page)).toHaveText("Read failed.");
    await expect(page.locator("#train")).toBeEnabled();
    await page.click("#train");
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    await expect(page.locator("#train")).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("a Train that fails after another raster opened shows no error on the new raster", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintTwo(page);
    await page.evaluate(() => {
      const s = (window as any).__geoapp.imagery();
      const g = (window as any).__gate = { reads: 0, fail: null as null | (() => void) };
      s.readWindow = () => { g.reads++; return new Promise((_, rej) => { g.fail = () => rej(new Error("Read failed.")); }); };
    });
    await page.click("#train");
    await expect.poll(() => page.evaluate(() => (window as any).__gate.reads)).toBe(1);
    page.once("dialog", (d) => d.accept());
    await openRaster(page, { ...rgbFixture(), name: "other.tif" });
    await expect(message(page)).toHaveText("Raster opened.");
    await page.evaluate(() => (window as any).__gate.fail());
    await expect(page.locator("#train")).toBeEnabled();
    await page.waitForTimeout(300);
    await expect(message(page)).toHaveText("Raster opened.");
    expect(errors).toEqual([]);
  });

  test("with only one class painted the message appears and no model is made", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const a = await toScreen(page, [12.005, 45.005]);
    await stroke(page, [a, { x: a.x + 60, y: a.y }]);
    await page.click("#train");
    await expect(message(page)).toHaveText(MESSAGES.paintTwo);
    await page.click("#save-model");
    await expect(message(page)).toHaveText("Train or load a model first.");
  });

  test("labels written on nodata through the hook give the no-samples message", async ({ page }) => {
    await openApp(page);
    // band 1 is nodata (-9) west of column 500
    await openRaster(page, tiff("nd.tif", 1000, 1000, 2, (b, c) => (b === 0 && c < 500 ? -9 : c + b), { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01], nodata: "-9" }));
    await expect(message(page)).toHaveText("Raster opened.");
    await page.evaluate(() => {
      const { store } = (window as any).__geoapp.labels;
      const t = new Uint8Array(256 * 256);
      t[0] = 1; t[1] = 2;
      store.tiles.set("0,0", t);
    });
    await page.click("#train");
    await expect(message(page)).toHaveText(MESSAGES.noSamples);
  });

  test(`with the store filled to MAX_LABEL_TILES (${MAX_LABEL_TILES}) through the hook, a dab on a new tile shows the limit message`, async ({ page }) => {
    await openApp(page);
    await openRaster(page, await stripTiff());
    await expect(message(page)).toHaveText("Raster opened.", { timeout: 30_000 });
    await page.evaluate((max) => {
      const { store } = (window as any).__geoapp.labels;
      for (let i = 0; i < max; i++) { const t = new Uint8Array(512); t[5] = 1; store.tiles.set(`${i * 256},0`, t); }
    }, MAX_LABEL_TILES);
    const lon = -175 + 0.005 * (256 * 256 + 100.5); // tile 256, the 257th
    await jumpTo(page, [lon, 9.995], 13);
    const p = await toScreen(page, [lon, 9.9975]);
    await page.mouse.click(p.x, p.y);
    await settled(page);
    await expect(message(page)).toHaveText(MESSAGES.labelLimit);
    expect(await page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size)).toBe(MAX_LABEL_TILES);
    // inside a stored tile a dab still applies
    await jumpTo(page, [lon - 0.005 * 256, 9.995], 13);
    const q = await toScreen(page, [lon - 0.005 * 256, 9.9975]);
    await page.mouse.click(q.x, q.y);
    await settled(page);
    expect((await labels(page)).size).toBeGreaterThan(MAX_LABEL_TILES);
  });
});

test("painting and training make no network requests (criterion 17)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await paintTwo(page);
  await stroke(page, [await toScreen(page, [13.005, 45.005]), await toScreen(page, [13.2, 45.005])], "right");
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
});
