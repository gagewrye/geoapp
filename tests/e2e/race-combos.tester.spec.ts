import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { westFile } from "./aefTester";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, rgbFixture, selectClass, stroke, tiff, toScreen, type Xy } from "./helpers";

// Tester pass 3 (F9-F11 and the Classify busy fix): Train, Classify, Load model, AlphaEarth and
// overlapping raster opens in combination, with cancel and failure paths.

const W_A: [number, number] = [13.005, 45.005], E_B: [number, number] = [17.005, 44.505];
const trainBtn = (page: Page) => page.locator("#train");
const classifyBtn = (page: Page) => page.locator("#classify");
const info = (page: Page) => page.locator("#raster-info");

/** Two short strokes at zoom 6: `first` at 13E, `second` at 17E (as brush-train-snapshot.tester). */
async function paintPair(page: Page, first: number, second: number) {
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, W_A), b = await toScreen(page, E_B);
  await selectClass(page, first);
  await stroke(page, [a, { x: a.x + 30, y: a.y + 20 }, { x: a.x + 60, y: a.y }]);
  await selectClass(page, second);
  await stroke(page, [b, { x: b.x + 30, y: b.y - 20 }, { x: b.x + 60, y: b.y }]);
}

/** A mouse stroke that doesn't wait for the paint queue. */
async function rawStroke(page: Page, pts: Xy[], button: "left" | "right" = "left") {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down({ button });
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up({ button });
}

/**
 * A Save dialog that answers at once and records each export (base64, on close). With `holdNext`
 * set, the next export's first write waits for `go()`; `fail` makes that write throw instead.
 */
async function savePicker(page: Page) {
  await page.addInitScript(() => {
    const g = (window as any).__save = { opened: 0, exports: [] as string[], holdNext: false, held: false, go: null as null | ((fail?: boolean) => void) };
    (window as any).showSaveFilePicker = async () => {
      g.opened++;
      const parts: Uint8Array[] = [];
      let first = g.holdNext;
      g.holdNext = false;
      return {
        createWritable: async () => ({
          write: async (d: Uint8Array) => {
            if (first) {
              first = false;
              g.held = true;
              const fail = await new Promise<boolean | undefined>((r) => { g.go = r; });
              g.held = false;
              if (fail) throw new Error("simulated write failure");
            }
            parts.push(d.slice());
          },
          close: async () => {
            let s = "";
            for (const p of parts) for (let i = 0; i < p.length; i += 0x8000) s += String.fromCharCode(...p.subarray(i, i + 0x8000));
            g.exports.push(btoa(s));
          },
          abort: async () => {},
        }),
      };
    };
  });
}
const exportsDone = (page: Page) => page.evaluate(() => (window as any).__save.exports.length as number);
const lastExport = (page: Page) => page.evaluate(() => (window as any).__save.exports.at(-1) as string);
const holdNextExport = (page: Page) => page.evaluate(() => { (window as any).__save.holdNext = true; });
const exportHeld = (page: Page) => page.evaluate(() => (window as any).__save.held as boolean);
const releaseExport = (page: Page, fail = false) => page.evaluate((fail) => (window as any).__save.go(fail), fail);

/** Classify and export, unheld, and return the file's base64. */
async function exportNow(page: Page): Promise<string> {
  const n = await exportsDone(page);
  await page.click("#classify");
  await expect(message(page)).toHaveText("Export complete.");
  await expect.poll(() => exportsDone(page)).toBe(n + 1);
  return lastExport(page);
}

async function geo(b64: string) {
  const buf = Buffer.from(b64, "base64");
  const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).getImage();
  return { size: [img.getWidth(), img.getHeight()], origin: img.getOrigin().slice(0, 2) };
}

async function savedModel(page: Page): Promise<{ text: string; json: unknown }> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-model")]);
  const text = (await readFile((await dl.path())!)).toString("utf8");
  return { text, json: JSON.parse(text) };
}
const loadModel = (page: Page, text: string) =>
  page.setInputFiles("#load-model", { name: "model.json", mimeType: "application/json", buffer: Buffer.from(text) });

/** Hold the open imagery's readWindow calls (Train and mask reads) until openGate. */
const gateReads = (page: Page) => page.evaluate(() => {
  const s = (window as any).__geoapp.imagery();
  const read = s.readWindow.bind(s);
  const g = (window as any).__gate = { hold: true, calls: [] as (() => void)[], failNext: false };
  s.readWindow = (...a: unknown[]) => {
    if (!g.hold) return read(...a);
    return new Promise((res, rej) => { g.calls.push(() => (g.failNext ? rej(new Error("Read failed.")) : read(...a).then(res, rej))); });
  };
});
const gatedCalls = (page: Page) => page.evaluate(() => (window as any).__gate.calls.length as number);
const openGate = (page: Page, fail = false) => page.evaluate((fail) => {
  const g = (window as any).__gate;
  g.hold = false;
  g.failNext = fail;
  for (const go of g.calls.splice(0)) go();
}, fail);

/** Hold FileReader reads of one file name ("all", or "committed": once #raster-info names it), as raster-race.spec.ts. */
async function fileGate(page: Page) {
  await page.addInitScript(() => {
    const g = (window as any).__files = { hold: new Map<string, string>(), waiting: [] as (() => void)[] };
    const slice = Blob.prototype.slice;
    Blob.prototype.slice = function (this: Blob, ...a: Parameters<Blob["slice"]>) {
      const b = slice.apply(this, a);
      (b as any).__name = (this as any).__name ?? (this as File).name;
      return b;
    };
    const read = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (this: FileReader, b: Blob) {
      const name = (b as any).__name as string | undefined, mode = name && g.hold.get(name);
      const held = mode === "all" || (mode === "committed" && document.getElementById("raster-info")!.textContent!.startsWith(`${name}:`));
      if (held) g.waiting.push(() => read.call(this, b));
      else read.call(this, b);
    };
  });
}
const holdFile = (page: Page, name: string, mode: "all" | "committed") =>
  page.evaluate(([name, mode]) => (window as any).__files.hold.set(name, mode), [name, mode] as const);
const fileWaiting = (page: Page) => page.evaluate(() => (window as any).__files.waiting.length as number);
const releaseFiles = (page: Page) => page.evaluate(() => {
  const g = (window as any).__files;
  g.hold.clear();
  for (const go of g.waiting.splice(0)) go();
});

/** 800 x 600, 3 bands, at 30..38E, 40..46N; band 1 is 200 west of 34E and 120 east of it. */
const otherFixture = () => tiff("other.tif", 800, 600, 3, (b, c) => (b === 0 ? (c < 400 ? 200 : 120) : 150),
  { epsg: 4326, gt: [30, 0.01, 0, 46, 0, -0.01] });

async function openRgb(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test.describe("Classify uses the model at the click (tester)", () => {
  test("Load model and Train during a held export: the file is the click's model; afterwards the newer model is in effect", async ({ page }) => {
    const errors = collectErrors(page);
    await savePicker(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
    const m1 = await savedModel(page);
    const e1 = await exportNow(page);
    await paintPair(page, 1, 0); // the same footprints with the classes swapped
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
    const m2 = await savedModel(page);
    const e2 = await exportNow(page);
    expect(e2).not.toBe(e1);

    // export with m2 held; Load model m1 meanwhile
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    await expect(classifyBtn(page)).toBeDisabled();
    await loadModel(page, m1.text);
    await expect(message(page)).toHaveText("Loaded model with classes: Class 1, Class 2.");
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page);
    await expect(message(page)).toHaveText("Export complete.");
    expect(await lastExport(page)).toBe(e2);
    await expect(classifyBtn(page)).toBeEnabled();
    expect((await savedModel(page)).json).toEqual(m1.json);
    expect(await exportNow(page)).toBe(e1);

    // export with m1 held; Train (labels are swapped, so m2) meanwhile
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    await expect(trainBtn(page)).toBeEnabled(); // Classify doesn't block Train
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page);
    await expect(message(page)).toHaveText("Export complete.");
    expect(await lastExport(page)).toBe(e1);
    expect((await savedModel(page)).json).toEqual(m2.json);
    expect(errors).toEqual([]);
  });

  test("a write failure after another raster opened: the error shows, Classify is enabled again, and a retry exports the new raster", async ({ page }) => {
    const errors = collectErrors(page);
    await savePicker(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on/);
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    page.once("dialog", (d) => d.accept());
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page, true);
    await expect(message(page)).toHaveText("simulated write failure");
    await expect(classifyBtn(page)).toBeEnabled();
    const out = await geo(await exportNow(page)); // the model (3 bands) still fits other.tif
    expect(out.size).toEqual([800, 600]);
    expect(out.origin).toEqual([30, 46]);
    expect(errors).toEqual([]);
  });
});

test("Load model during a held Train: the last message describes the model in effect (the run's, which ends last)", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await openRgb(page);
  await paintPair(page, 0, 1);
  const n = (await labels(page)).size;
  await page.click("#train");
  await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
  const m1 = await savedModel(page);
  await paintPair(page, 1, 0); // swapped classes, so the next run's model differs
  await gateReads(page);
  await page.click("#train");
  await expect.poll(() => gatedCalls(page)).toBe(1);
  await loadModel(page, m1.text);
  await expect(message(page)).toHaveText("Loaded model with classes: Class 1, Class 2.");
  expect((await savedModel(page)).json).toEqual(m1.json);
  await openGate(page);
  await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
  expect((await savedModel(page)).json).not.toEqual(m1.json);
  expect(errors).toEqual([]);
});

test.describe("AlphaEarth state changes during a run (tester)", () => {
  test("opening an AlphaEarth file during a held export keeps Classify disabled until it ends; the file is the local raster's", async ({ page }) => {
    const errors = collectErrors(page);
    await savePicker(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const before = await labels(page);
    await page.click("#train");
    await expect(message(page)).toHaveText(/^Trained on/);
    await holdNextExport(page);
    await page.click("#classify");
    await expect.poll(() => exportHeld(page)).toBe(true);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    await expect(classifyBtn(page)).toBeDisabled();
    await expect(trainBtn(page)).toBeEnabled();
    await page.waitForTimeout(300);
    await expect(classifyBtn(page)).toBeDisabled();
    await releaseExport(page);
    await expect(message(page)).toHaveText("Export complete.");
    await expect(classifyBtn(page)).toBeEnabled();
    const out = await geo(await lastExport(page));
    expect(out.size).toEqual([1000, 1000]);
    expect(out.origin).toEqual([10, 50]);
    expect(await labels(page)).toEqual(before); // AlphaEarth leaves the labels alone
    await expect(page.locator("#brush-panel")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("opening an AlphaEarth file during a held Train keeps Train disabled until it ends, and the run's model stands", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const n = (await labels(page)).size;
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    await expect(trainBtn(page)).toBeDisabled();
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    await expect(trainBtn(page)).toBeEnabled();
    expect((await savedModel(page)).json).toMatchObject({ classes: ["Class 1", "Class 2"] });
    expect(errors).toEqual([]);
  });
});

test.describe("Train and opens that don't replace the raster (tester)", () => {
  test("an Open raster refused as AlphaEarth during a held Train: the run is not dropped", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const n = (await labels(page)).size;
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    await openRaster(page, westFile());
    await expect(message(page)).toHaveText("This is an AlphaEarth file. Use Open AlphaEarth file.");
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    await expect(trainBtn(page)).toBeEnabled();
    expect((await savedModel(page)).json).toMatchObject({ classes: ["Class 1", "Class 2"] });
    expect(errors).toEqual([]);
  });

  test("an open cancelled at Discard labels? during a held Train: the run is not dropped and the labels stay", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    const before = await labels(page);
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.dismiss(); });
    await openRaster(page, otherFixture());
    await expect.poll(() => asked).toBe(1);
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${before.size} pixels, 2 classes.`);
    expect(await labels(page)).toEqual(before);
    await expect(info(page)).toHaveText(/^rgb4326\.tif: 1000 x 1000/);
    expect(errors).toEqual([]);
  });

  test("a Train that fails after another raster opened: no error, and Train stays disabled on the new raster until the old run ends, then trains the new labels", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await gateReads(page);
    await page.click("#train");
    await expect.poll(() => gatedCalls(page)).toBe(1);
    page.once("dialog", (d) => d.accept());
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    // label other.tif: class 1 west of 34E, class 2 east (its reads aren't gated)
    await jumpTo(page, [34, 43], 6);
    const a = await toScreen(page, [31.005, 43.005]), b = await toScreen(page, [36.005, 43.005]);
    await selectClass(page, 0);
    await rawStroke(page, [a, { x: a.x + 40, y: a.y }]);
    await selectClass(page, 1);
    await rawStroke(page, [b, { x: b.x + 40, y: b.y }]);
    await page.waitForTimeout(500);
    await expect(trainBtn(page)).toBeDisabled(); // the old run still holds the one snapshot
    await openGate(page, true);
    await expect(trainBtn(page)).toBeEnabled();
    await expect(message(page)).toHaveText("Raster opened.");
    const n = (await labels(page)).size;
    expect(n).toBeGreaterThan(0);
    await page.click("#train");
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    expect(errors).toEqual([]);
  });
});

test.describe("overlapping opens with labels (tester)", () => {
  test("an older open released after a newer one opened and was labelled: no confirm, labels, raster and Train unchanged", async ({ page }) => {
    const errors = collectErrors(page);
    await fileGate(page);
    await openApp(page);
    await holdFile(page, "slow.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(0);
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [34, 43], 6);
    const a = await toScreen(page, [31.005, 43.005]), b = await toScreen(page, [36.005, 43.005]);
    await selectClass(page, 0);
    await stroke(page, [a, { x: a.x + 40, y: a.y }]);
    await selectClass(page, 1);
    await stroke(page, [b, { x: b.x + 40, y: b.y }]);
    const before = await labels(page);
    expect(before.size).toBeGreaterThan(0);
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.dismiss(); });
    await releaseFiles(page);
    await page.waitForTimeout(800);
    expect(asked).toBe(0);
    expect(await labels(page)).toEqual(before);
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    await page.click("#train");
    await expect(message(page)).toHaveText(`Trained on ${before.size} pixels, 2 classes.`);
    expect(errors).toEqual([]);
  });

  test("a newer open cancelled at Discard labels? while the older one builds its preview: the older raster, its labels and its preview stay", async ({ page }) => {
    const errors = collectErrors(page);
    await fileGate(page);
    await openApp(page);
    await holdFile(page, "slow.tif", "committed");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(0);
    // mask reads of slow.tif are held too, so label through the hook (off nodata: the fixture has none)
    await page.evaluate(() => {
      const { store } = (window as any).__geoapp.labels;
      const t = new Uint8Array(256 * 256);
      t.fill(1, 0, 100);
      t.fill(2, 1000, 1100);
      store.tiles.set("0,0", t);
    });
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.dismiss(); });
    await openRaster(page, otherFixture());
    await expect.poll(() => asked).toBe(1);
    await releaseFiles(page);
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getSource("preview")?.coordinates[0][0] as number)).toBeCloseTo(10, 6);
    expect((await labels(page)).size).toBe(200);
    await page.click("#train");
    await expect(message(page)).toHaveText("Trained on 200 pixels, 2 classes.");
    expect(errors).toEqual([]);
  });

  test("two opens both held at the header, released newest first then oldest: the newest stands with one confirm", async ({ page }) => {
    const errors = collectErrors(page);
    await fileGate(page);
    await openApp(page);
    await openRgb(page);
    await paintPair(page, 0, 1);
    await holdFile(page, "a.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "a.tif" });
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(0);
    const heldA = await fileWaiting(page);
    await holdFile(page, "other.tif", "all");
    await openRaster(page, otherFixture());
    await expect.poll(() => fileWaiting(page)).toBeGreaterThan(heldA);
    let asked = 0;
    page.on("dialog", (d) => { asked++; void d.accept(); });
    // release other.tif only (it was queued after a.tif)
    await page.evaluate((k) => {
      const g = (window as any).__files;
      g.hold.delete("other.tif");
      for (const go of g.waiting.splice(k)) go();
    }, heldA);
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    await expect(message(page)).toHaveText("Raster opened.");
    await releaseFiles(page);
    await page.waitForTimeout(800);
    expect(asked).toBe(1);
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    expect(await page.evaluate(() => (window as any).__geoapp.imagery().meta.width)).toBe(800);
    expect((await labels(page)).size).toBe(0);
    await expect(message(page)).toHaveText("Raster opened.");
    expect(errors).toEqual([]);
  });
});
