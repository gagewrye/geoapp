import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { AefEntry } from "../../src/core/aef";
import { toLonLat } from "../../src/core/crs";
import { MESSAGES } from "../../src/ui/messages";
import { chip } from "./aef";
import { jumpTo, labels, message, openApp, openRaster, rgbFixture, settled, stroke, tiff, toScreen } from "./helpers";

// Spec 003 criteria 7 (no polygons; the brush is for local imagery only) and 16 (discard).

const FIX = "tests/fixtures/aef";
const west = (JSON.parse(readFileSync(`${FIX}/aef-index/2021/32617.json`, "utf8")) as AefEntry[])[0]!;
const westFile = () => ({ name: "west.tiff", mimeType: "image/tiff", buffer: readFileSync(`${FIX}/cogs/${west.path}`) });
const features = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().length as number);

test.describe("no polygons (criterion 7)", () => {
  test("there is no polygon draw or select control; with a local GeoTIFF open the brush panel shows and a left drag adds no terra-draw feature", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#brush-panel")).toBeHidden();
    for (const id of ["#mode-draw", "#mode-select", "#polygons", "#class-name"]) await expect(page.locator(id)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /polygon|edit/i })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys((window as any).__geoapp.draw._modes).sort())).toEqual(["rectangle", "static"]);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await expect(page.locator("#brush-panel")).toBeVisible();
    await jumpTo(page, [15, 45], 7);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 80, y: c.y + 30 }]);
    expect((await labels(page)).size).toBeGreaterThan(0);
    expect(await features(page)).toBe(0);
  });

  test("with only AlphaEarth data loaded the brush panel is hidden and a drag over its preview labels nothing", async ({ page }) => {
    await openApp(page);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    await expect(page.locator("#brush-panel")).toBeHidden();
    const c = await toScreen(page, toLonLat(chip.epsg, chip.x0 + 300, chip.y1 - 600) as [number, number]);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 60, c.y + 20, { steps: 10 });
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size)).toBe(0);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getSource("brush-hover") ?? null)).toBeNull();
  });

  test("Open GeoTIFF on a fixture (a) AlphaEarth COG shows the refusal and opens nothing", async ({ page }) => {
    await openApp(page);
    await openRaster(page, westFile());
    await expect(message(page)).toHaveText(MESSAGES.rasterIsAef);
    expect(MESSAGES.rasterIsAef).toBe("This is an AlphaEarth file. Use Open AlphaEarth file.");
    expect(await page.evaluate(() => (window as any).__geoapp.imagery())).toBeNull();
    expect(await page.evaluate(() => Boolean((window as any).__geoapp.map.getSource("preview")))).toBe(false);
    await expect(page.locator("#brush-panel")).toBeHidden();
  });
});

test.describe("discard (criterion 16)", () => {
  const other = () => tiff("other.tif", 300, 300, 3, (b, c, r) => (c + r + b) % 200, { epsg: 4326, gt: [12, 0.01, 0, 47, 0, -0.01] });

  test("with labels painted the confirm shows: Cancel keeps the raster and labels, OK opens the new raster with an empty store", async ({ page }) => {
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await jumpTo(page, [15, 45], 7);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 80, y: c.y }]);
    const before = await labels(page);
    expect(before.size).toBeGreaterThan(0);

    const dialogs: string[] = [];
    page.once("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await openRaster(page, other());
    await expect.poll(() => dialogs).toEqual([MESSAGES.discard]);
    await page.waitForTimeout(200);
    await expect(page.locator("#raster-info")).toHaveText(/^rgb4326\.tif: 1000 x 1000/);
    expect(await page.evaluate(() => (window as any).__geoapp.imagery().meta.width)).toBe(1000);
    expect(await labels(page)).toEqual(before);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getLayer(`label-${[...(window as any).__geoapp.labels.store.tiles.keys()][0]}`) !== undefined)).toBe(true);

    page.once("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
    await openRaster(page, other());
    await expect(message(page)).toHaveText("Raster opened.");
    expect(dialogs).toEqual([MESSAGES.discard, MESSAGES.discard]);
    await expect(page.locator("#raster-info")).toHaveText(/^other\.tif: 300 x 300/);
    expect(await page.evaluate(() => { const s = (window as any).__geoapp.labels.store; return [s.width, s.height, s.tiles.size]; })).toEqual([300, 300, 0]);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.filter((l: any) => l.id.startsWith("label-")).length)).toBe(0);
    await settled(page);
  });

  test("with no labels painted no confirm is shown", async ({ page }) => {
    await openApp(page);
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await openRaster(page, other());
    await expect(page.locator("#raster-info")).toHaveText(/^other\.tif/);
    await expect(message(page)).toHaveText("Raster opened.");
    expect(dialogs).toBe(0);
  });
});
