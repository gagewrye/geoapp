import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { message, openApp, openRaster, paintTwoClasses, rgbFixture, tiff } from "./helpers";

test("open and paint with no outside requests (criterion 1)", async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintTwoClasses(page); // spec 003's brush replaces spec 001's polygons

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
