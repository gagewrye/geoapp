import { expect, test, type Page } from "@playwright/test";
import { footprint, footprintRing, pixelAt, strokeCells } from "../../src/core/pixel";
import type { Grid } from "../../src/core/types";
import { hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, settled, tiff, tileKeysStored, toLngLat, toScreen, type LngLat, type Xy } from "./helpers";

// Spec 003 criterion 19: the brush never labels imagery nodata.

const GRID: Grid = { width: 512, height: 512, epsg: 4326, gt: [20, 0.0001, 0, 40, 0, -0.0001] };
/** Band 2 is nodata (-9999) on cols/rows 100..129; band 3 (Float32) is NaN on cols 300..329, rows 100..129. */
const inNodata = (c: number, r: number) => r >= 100 && r < 130 && c >= 100 && c < 130;
const inNan = (c: number, r: number) => r >= 100 && r < 130 && c >= 300 && c < 330;
const value = (b: number, c: number, r: number) =>
  b === 1 && inNodata(c, r) ? -9999 : b === 2 && inNan(c, r) ? NaN : b === 0 ? (c < 256 ? 30 : 90) + (r % 7) : b === 1 ? c % 50 : r % 40;
const fixture = () => tiff("nodata.tif", 512, 512, 3, value, { epsg: 4326, gt: GRID.gt, nodata: "-9999" });
const lonLat = (c: number, r: number): LngLat => [GRID.gt[0] + c * GRID.gt[1], GRID.gt[3] + r * GRID.gt[5]];

async function setup(page: Page, centre: [number, number] = [215, 115]) {
  await openApp(page);
  await openRaster(page, fixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, lonLat(...centre), 14); // about 2.3 screen px per pixel, so a 260 px drag stays on the map
  await page.click("#brush-larger"); // size 15
  await expect(page.locator("#brush-size")).toHaveText("Brush: 15 px");
}
/** Screen point of a pixel centre. */
const at = (page: Page, c: number, r: number) => toScreen(page, lonLat(c + 0.5, r + 0.5));

/** Pixels under the size-15 footprints of the stroke through these screen points, minus imagery nodata. */
async function expected(page: Page, pts: Xy[]): Promise<Set<string>> {
  const cells = (await toLngLat(page, pts)).map(([lon, lat]) => pixelAt(GRID, lon, lat));
  const out = new Set<string>();
  cells.flatMap((c, i) => (i === 0 ? [c] : strokeCells(cells[i - 1]!, c))).forEach(([c, r]) => {
    const w = footprint(GRID, c, r, 15)!;
    for (let y = w.y0; y < w.y0 + w.height; y++) for (let x = w.x0; x < w.x0 + w.width; x++) if (!inNodata(x, y) && !inNan(x, y)) out.add(`${x},${y}`);
  });
  return out;
}
async function drag(page: Page, pts: Xy[]) {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
}
const across = async (page: Page, c0: number, c1: number, r: number, n = 12) =>
  Promise.all(Array.from({ length: n }, (_, i) => at(page, c0 + ((c1 - c0) * i) / (n - 1), r)));

test.describe("imagery nodata (criterion 19)", () => {
  test("a size-15 drag across each block labels every pixel under its footprints except the block's", async ({ page }) => {
    await setup(page);
    const pts = await across(page, 85, 345, 115, 30);
    await drag(page, pts);
    await settled(page);
    const got = new Set((await labels(page)).keys());
    expect(got.size).toBeGreaterThan(3000);
    expect(got).toEqual(await expected(page, pts));
    for (const k of got) { const [c, r] = k.split(",").map(Number) as [number, number]; expect(inNodata(c, r) || inNan(c, r), k).toBe(false); }
  });

  for (const [name, c] of [["nodata", 115], ["NaN", 315]] as const) {
    test(`a dab inside the ${name} block creates no tile, and the hover ring over it is the full footprint`, async ({ page }) => {
      await setup(page, [c, 115]);
      const p = await at(page, c, 115);
      await page.mouse.move(p.x - 2, p.y);
      await page.mouse.move(p.x, p.y);
      await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
      const ring: LngLat[] = (await hoverFeatures(page))[0].geometry.coordinates[0];
      const [ll] = await toLngLat(page, [p]);
      const [pc, pr] = pixelAt(GRID, ...ll!);
      const want = footprintRing(GRID, { x0: pc - 7, y0: pr - 7, width: 15, height: 15 });
      ring.forEach(([lon, lat], i) => { expect(Math.abs(lon - want[i]![0])).toBeLessThan(1e-9); expect(Math.abs(lat - want[i]![1])).toBeLessThan(1e-9); });
      await page.mouse.down();
      await page.mouse.up();
      await settled(page);
      expect(await tileKeysStored(page)).toEqual([]);
    });
  }

  test("with the imagery source paused a drag labels the same pixels once reads resume, even after release; Import labels is disabled until then", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      const s = (window as any).__geoapp.imagery();
      const read = s.readWindow.bind(s);
      const g = (window as any).__gate = { held: true, open: null as null | (() => void), wait: null as null | Promise<void> };
      g.wait = new Promise<void>((r) => { g.open = r; });
      s.readWindow = async (...a: unknown[]) => { if (g.held) await g.wait; return read(...a); };
    });
    const pts = await across(page, 85, 345, 115, 30);
    await drag(page, pts);
    await page.waitForTimeout(300);
    await expect(page.locator("#import-labels")).toBeDisabled();
    expect((await labels(page)).size).toBe(0);
    await page.evaluate(() => { const g = (window as any).__gate; g.held = false; g.open(); });
    await settled(page);
    expect(new Set((await labels(page)).keys())).toEqual(await expected(page, pts));
  });
});
