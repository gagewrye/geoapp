import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { validate } from "../../src/core/validate";
import { MESSAGES } from "../../src/ui/messages";
import { message, openApp, openRaster, paintTwoClasses, rgbFixture, tiff } from "./helpers";

async function download(page: Page, click: string): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(click)]);
  return readFile((await dl.path())!);
}

test("open, train, classify, export and save/load a model with no outside requests (criterion 1)", async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  // Force the OPFS + download path so the export can be captured (no native Save dialog in tests).
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintTwoClasses(page); // spec 003's brush replaces spec 001's polygons

  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);

  const tif = await download(page, "#classify");
  await expect(message(page)).toHaveText("Export complete.");
  const img = await (await fromArrayBuffer(tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength) as ArrayBuffer)).getImage();
  expect([img.getWidth(), img.getHeight()]).toEqual([1000, 1000]);
  const [px] = (await img.readRasters({ window: [100, 500, 101, 501] })) as unknown as Uint8Array[];
  const [px2] = (await img.readRasters({ window: [900, 500, 901, 501] })) as unknown as Uint8Array[];
  expect([px![0], px2![0]]).toEqual([0, 1]);

  const json = (await download(page, "#save-model")).toString("utf8");
  const model: unknown = JSON.parse(json);
  validate(model, 3);
  expect(model.classes).toEqual(["left", "right"]);
  await page.setInputFiles("#load-model", { name: "model.json", mimeType: "application/json", buffer: Buffer.from(json) });
  await expect(message(page)).toHaveText("Loaded model with classes: left, right.");

  const outside = requests.filter((u) => !u.startsWith(baseURL!) && !u.startsWith("blob:") && !u.startsWith("data:"));
  expect(outside).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
});

// Criterion 2 (draw polygons and name them) is superseded by spec 003 criteria 10 and 14 (brush-paint, brush-panel).

test.describe("rasters at 180 degrees (criterion 16)", () => {
  const one = () => 100;
  const cases = [
    { name: "EPSG:4326 crossing 180", file: () => tiff("x4326.tif", 100, 100, 1, one, { epsg: 4326, gt: [179.5, 0.01, 0, 10, 0, -0.01] }), opens: false },
    { name: "EPSG:3857 crossing 180", file: () => tiff("x3857.tif", 200, 100, 1, one, { epsg: 3857, gt: [19900000, 1000, 0, 100000, 0, -1000] }), opens: false },
    { name: "EPSG:4326 edge exactly at 180", file: () => tiff("e4326.tif", 1000, 100, 1, one, { epsg: 4326, gt: [179, 0.001, 0, 10, 0, -0.001] }), opens: true },
    { name: "UTM zone 60 touching 180", file: () => tiff("z60.tif", 1000, 100, 1, one, { epsg: 32660, gt: [800000, 30, 0, 1110000, 0, -30] }), opens: true },
  ];
  for (const c of cases) {
    test(`${c.name} ${c.opens ? "opens" : "is refused"}`, async ({ page }) => {
      await openApp(page);
      await openRaster(page, c.file());
      await expect(message(page)).toHaveText(c.opens ? "Raster opened." : MESSAGES.rasterAntimeridian);
      const hasPreview = await page.evaluate(() => Boolean((window as any).__geoapp.map.getSource("preview")));
      expect(hasPreview).toBe(c.opens);
    });
  }
});
