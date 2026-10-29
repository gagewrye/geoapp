import { expect, test, type Page } from "@playwright/test";
import { footprint, footprintRing, pixelAt } from "../../src/core/pixel";
import { MAX_LAT, type Grid } from "../../src/core/types";
import { collectErrors, hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, pixelAt as screenPixel, settled, tiff, tileKeysStored, toLngLat, toScreen, type LngLat, type Xy } from "./helpers";

// Tester: spec 003 at raster edges and partial tiles, and beyond MAX_LAT (labelled, not drawn).

const EDGE: Grid = { width: 300, height: 260, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] };
const edgeFixture = () => tiff("edge.tif", 300, 260, 3, (b, c, r) => (b === 0 ? (c < 150 ? 40 : 160) : (c + r + b) % 90), { epsg: 4326, gt: EDGE.gt });
const centre = (g: Grid, c: number, r: number): LngLat => [g.gt[0] + (c + 0.5) * g.gt[1], g.gt[3] + (r + 0.5) * g.gt[5]];
const round = (p: Xy): Xy => ({ x: Math.round(p.x), y: Math.round(p.y) });
const labelLayers = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: any) => l.id as string));

async function setSize(page: Page, px: number) {
  while ((await page.locator("#brush-size").textContent()) !== `Brush: ${px} px`) await page.click("#brush-larger");
}

test.describe("raster edges and partial tiles (tester)", () => {
  test("pointer just off the west edge: the hover is the clipped footprint and a click labels exactly it; 4 px off shows and labels nothing", async ({ page }) => {
    await openApp(page);
    await openRaster(page, edgeFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await jumpTo(page, centre(EDGE, 0, 130), 12);
    for (const [col, want] of [[-2, footprint(EDGE, -2, 130, 7)], [-4, null]] as const) {
      const p = round(await toScreen(page, centre(EDGE, col, 130)));
      await page.mouse.move(p.x - 1, p.y);
      await page.mouse.move(p.x, p.y);
      const [ll] = await toLngLat(page, [p]);
      expect(pixelAt(EDGE, ...ll!)).toEqual([col, 130]);
      if (!want) { await expect.poll(async () => (await hoverFeatures(page)).length).toBe(0); continue; }
      await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
      const ring: LngLat[] = (await hoverFeatures(page))[0].geometry.coordinates[0];
      footprintRing(EDGE, want).forEach(([lon, lat], i) => { expect(Math.abs(ring[i]![0] - lon)).toBeLessThan(1e-9); expect(Math.abs(ring[i]![1] - lat)).toBeLessThan(1e-9); });
    }
    // click at col -2 labels the clipped 2 x 7 window; at -4 nothing
    const p2 = round(await toScreen(page, centre(EDGE, -2, 130)));
    await page.mouse.click(p2.x, p2.y);
    await settled(page);
    expect([...(await labels(page)).keys()].sort()).toEqual(["0,127", "0,128", "0,129", "0,130", "0,131", "0,132", "0,133", "1,127", "1,128", "1,129", "1,130", "1,131", "1,132", "1,133"].sort());
    const p4 = round(await toScreen(page, centre(EDGE, -4, 100)));
    await page.mouse.click(p4.x, p4.y);
    await settled(page);
    expect((await labels(page)).size).toBe(14);
  });

  test("a size-127 dab on the bottom-right corner of a 300x260 raster fills the 4 partial tiles' clipped window, each gets an overlay between preview and hover, and it is drawn", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRaster(page, edgeFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await setSize(page, 127);
    await jumpTo(page, centre(EDGE, 270, 240), 8);
    const probe = round(await toScreen(page, centre(EDGE, 290, 250)));
    const before = await screenPixel(page, probe);
    const p = round(await toScreen(page, centre(EDGE, 299, 259)));
    await page.mouse.click(p.x, p.y);
    await settled(page);
    const got = new Set((await labels(page)).keys());
    const want = new Set<string>();
    for (let r = 196; r < 260; r++) for (let c = 236; c < 300; c++) want.add(`${c},${r}`);
    expect(got).toEqual(want);
    expect(await tileKeysStored(page)).toEqual(["0,0", "0,256", "256,0", "256,256"]);
    // a tile is one or more quads, label-${key} or label-${key}-${i} (spec 018)
    const tilesDrawn = async () => new Set((await labelLayers(page)).filter((id) => id.startsWith("label-")).map((id) => id.split("-")[1])).size;
    await expect.poll(tilesDrawn).toBe(4);
    const ids = await labelLayers(page);
    const pos = (pred: (id: string) => boolean) => ids.findIndex(pred);
    const labelIdx = ids.map((id, i) => (id.startsWith("label-") ? i : -1)).filter((i) => i >= 0);
    expect(pos((id) => id === "preview")).toBeLessThan(Math.min(...labelIdx));
    expect(Math.max(...labelIdx)).toBeLessThan(pos((id) => id.startsWith("brush-hover")));
    await expect.poll(async () => (await screenPixel(page, probe)).slice(0, 3)).not.toEqual(before.slice(0, 3));
    expect(errors).toEqual([]);
  });
});

test.describe("beyond MAX_LAT (tester)", () => {
  // 0.017 degree pixels from 90N: rows 0..255 (tile row 0) lie wholly beyond MAX_LAT, and MAX_LAT is row ~291
  const POLE: Grid = { width: 300, height: 600, epsg: 4326, gt: [0, 0.017, 0, 90, 0, -0.017] };
  const poleFixture = () => tiff("pole.tif", 300, 600, 2, (b, c, r) => (b === 0 ? (r < 400 ? 20 : 200) : (c + r) % 50), { epsg: 4326, gt: POLE.gt });

  test("an overhanging size-127 footprint labels pixels beyond MAX_LAT, including a tile wholly beyond it, and nothing throws", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await openRaster(page, poleFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await paintMode(page);
    await setSize(page, 127);
    await jumpTo(page, [2.55, 85.0], 5);
    const p = round(await toScreen(page, [2.55, 85.0]));
    await page.mouse.move(p.x - 1, p.y);
    await page.mouse.move(p.x, p.y);
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
    const ring: LngLat[] = (await hoverFeatures(page))[0].geometry.coordinates[0];
    expect(Math.max(...ring.map((q) => q[1]))).toBeGreaterThan(MAX_LAT); // the full footprint, past the limit
    await page.mouse.down();
    await page.mouse.up();
    await settled(page);
    const [ll] = await toLngLat(page, [p]);
    const [, row] = pixelAt(POLE, ...ll!);
    expect(row).toBeGreaterThan(256 + 20);
    const got = await labels(page);
    const rows = [...got.keys()].map((k) => Number(k.split(",")[1]));
    expect(Math.min(...rows)).toBe(row - 63);
    expect(Math.min(...rows)).toBeLessThan(256); // into tile row 0, wholly beyond MAX_LAT
    expect(await tileKeysStored(page)).toContain("0,0");
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});
