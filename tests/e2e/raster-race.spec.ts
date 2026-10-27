import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { jumpTo, message, openApp, openRaster, rgbFixture, selectClass, stroke, tiff, toScreen } from "./helpers";

// Async actions tied to the raster they started on (spec 003, tester F10): an open that another open
// overtakes, and a Classify while another raster opens.

/** 800 x 600, 3 bands, at 30..38E, 40..46N: a different size and place from rgbFixture. */
const otherFixture = () => tiff("other.tif", 800, 600, 3, (b, c) => (b === 0 ? (c < 400 ? 200 : 120) : 150),
  { epsg: 4326, gt: [30, 0.01, 0, 46, 0, -0.01] });
const info = (page: Page) => page.locator("#raster-info");
const imageryWidth = (page: Page) => page.evaluate(() => (window as any).__geoapp.imagery()?.meta.width as number | undefined);
const previewWest = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getSource("preview")?.coordinates[0][0] as number | undefined);

/**
 * Hold FileReader reads of one file name: "all" from the start, or "committed" only once that file is
 * the open raster (#raster-info names it), so its preview waits but its header doesn't.
 */
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
const hold = (page: Page, name: string, mode: "all" | "committed") =>
  page.evaluate(([name, mode]) => (window as any).__files.hold.set(name, mode), [name, mode] as const);
const waiting = (page: Page) => page.evaluate(() => (window as any).__files.waiting.length as number);
const releaseFiles = (page: Page) => page.evaluate(() => {
  const g = (window as any).__files;
  g.hold.clear();
  for (const go of g.waiting.splice(0)) go();
});

test.describe("an open that another open overtakes", () => {
  test("an older open still reading its header doesn't replace the raster opened after it", async ({ page }) => {
    await fileGate(page);
    await openApp(page);
    await hold(page, "slow.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect.poll(() => waiting(page)).toBeGreaterThan(0);
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    await releaseFiles(page);
    await page.waitForTimeout(800);
    await expect(info(page)).toHaveText(/^other\.tif: 800 x 600/);
    expect(await imageryWidth(page)).toBe(800);
    expect(await previewWest(page)).toBeCloseTo(30, 6);
    await expect(message(page)).toHaveText("Raster opened.");
  });

  test("an older open still building its preview doesn't show it over the raster opened after it", async ({ page }) => {
    await fileGate(page);
    await openApp(page);
    await hold(page, "slow.tif", "committed");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
    await expect.poll(() => waiting(page)).toBeGreaterThan(0); // its preview reads wait
    await openRaster(page, otherFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    expect(await previewWest(page)).toBeCloseTo(30, 6);
    const center = await page.evaluate(() => (window as any).__geoapp.map.getCenter().lng as number);
    await releaseFiles(page);
    await page.waitForTimeout(800);
    expect(await previewWest(page)).toBeCloseTo(30, 6);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getCenter().lng as number)).toBeCloseTo(center, 6);
    expect(await imageryWidth(page)).toBe(800);
  });

  test("a newer open that is refused leaves the older open to finish", async ({ page }) => {
    await fileGate(page);
    await openApp(page);
    await hold(page, "slow.tif", "all");
    await openRaster(page, { ...rgbFixture(), name: "slow.tif" });
    await expect.poll(() => waiting(page)).toBeGreaterThan(0);
    await openRaster(page, tiff("swiss.tif", 4, 4, 1, () => 1, { epsg: 2056, gt: [2600000, 10, 0, 1200000, 0, -10] }));
    await expect(message(page)).toHaveText(/Unsupported CRS EPSG:2056/);
    await releaseFiles(page);
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(info(page)).toHaveText(/^slow\.tif: 1000 x 1000/);
  });
});

test("Classify exports the raster it was clicked on, even if another opens before the Save dialog returns", async ({ page }) => {
  await page.addInitScript(() => {
    const g = (window as any).__save = { pick: null as null | (() => void), parts: [] as Uint8Array[], b64: "" };
    (window as any).showSaveFilePicker = () => new Promise((r) => {
      g.pick = () => r({
        createWritable: async () => ({
          write: async (d: Uint8Array) => { g.parts.push(d.slice()); },
          close: async () => {
            let s = "";
            for (const p of g.parts) for (let i = 0; i < p.length; i += 0x8000) s += String.fromCharCode(...p.subarray(i, i + 0x8000));
            g.b64 = btoa(s);
          },
          abort: async () => {},
        }),
      });
    });
  });
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [13.005, 45.005]), b = await toScreen(page, [17.005, 44.505]);
  await stroke(page, [a, { x: a.x + 60, y: a.y }]);
  await selectClass(page, 1);
  await stroke(page, [b, { x: b.x + 60, y: b.y }]);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on/);
  await page.click("#classify");
  await expect.poll(() => page.evaluate(() => (window as any).__save.pick !== null)).toBe(true);
  page.once("dialog", (d) => d.accept());
  await openRaster(page, otherFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.evaluate(() => (window as any).__save.pick());
  await expect(message(page)).toHaveText("Export complete.");
  const b64 = await page.evaluate(() => (window as any).__save.b64 as string);
  const buf = Buffer.from(b64, "base64");
  const out = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).getImage();
  expect([out.getWidth(), out.getHeight()]).toEqual([1000, 1000]);
  expect(out.getOrigin().slice(0, 2)).toEqual([10, 50]);
});
