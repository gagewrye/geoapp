import { expect, test, type Page } from "@playwright/test";
import { footprint, pixelAt, strokeCells } from "../../src/core/pixel";
import type { Grid } from "../../src/core/types";
import { hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, settled, tiff, toLngLat, toScreen, type LngLat, type Xy } from "./helpers";

// Tester: spec 003 Imagery nodata on a 4-band raster whose GDAL_NODATA (0) appears in the last band
// only, plus a NaN block in band 1; and the paint queue with reads paused (hover stays synchronous,
// erase waits its turn, Import labels waits for the queue).

const GRID: Grid = { width: 600, height: 300, epsg: 4326, gt: [30, 0.0001, 0, 20, 0, -0.0001] };
const inZero = (c: number, r: number) => c >= 200 && c < 240 && r >= 130 && r < 170; // band 4 = 0
const inNan = (c: number, r: number) => c >= 300 && c < 340 && r >= 130 && r < 170; // band 1 = NaN
const nodata = (c: number, r: number) => inZero(c, r) || inNan(c, r);
const fixture = () => tiff("nd4.tif", 600, 300, 4, (b, c, r) =>
  (b === 3 && inZero(c, r) ? 0 : b === 0 && inNan(c, r) ? NaN : 1 + ((c * (b + 1) + r) % 50) + (c < 300 ? 0 : 100 * (b === 0 ? 1 : 0))), { epsg: 4326, gt: GRID.gt, nodata: "0" });
const lonLat = (c: number, r: number): LngLat => [GRID.gt[0] + c * GRID.gt[1], GRID.gt[3] + r * GRID.gt[5]];
const round = (p: Xy): Xy => ({ x: Math.round(p.x), y: Math.round(p.y) });

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, fixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, lonLat(270, 150), 14);
  for (let i = 0; i < 2; i++) await page.click("#brush-larger"); // 31
  await expect(page.locator("#brush-size")).toHaveText("Brush: 31 px");
}
async function points(page: Page, c0: number, c1: number, r: number, n: number): Promise<Xy[]> {
  return Promise.all(Array.from({ length: n }, async (_, i) => round(await toScreen(page, lonLat(c0 + ((c1 - c0) * i) / (n - 1) + 0.5, r + 0.5)))));
}
async function expected(page: Page, pts: Xy[], side: number): Promise<Set<string>> {
  const cells = (await toLngLat(page, pts)).map(([lon, lat]) => pixelAt(GRID, lon, lat));
  const out = new Set<string>();
  cells.flatMap((c, i) => (i === 0 ? [c] : strokeCells(cells[i - 1]!, c))).forEach(([c, r]) => {
    const w = footprint(GRID, c, r, side)!;
    for (let y = w.y0; y < w.y0 + w.height; y++) for (let x = w.x0; x < w.x0 + w.width; x++) if (!nodata(x, y)) out.add(`${x},${y}`);
  });
  return out;
}
async function drag(page: Page, pts: Xy[], button: "left" | "right" = "left") {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down({ button });
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up({ button });
}

test("band-4-only nodata (GDAL_NODATA 0) and band-1 NaN are never labelled", async ({ page }) => {
  await setup(page);
  const pts = await points(page, 185, 355, 150, 24);
  await drag(page, pts);
  await settled(page);
  const got = new Set((await labels(page)).keys());
  expect(got).toEqual(await expected(page, pts, 31));
  for (const k of got) { const [c, r] = k.split(",").map(Number) as [number, number]; expect(nodata(c, r), k).toBe(false); }
});

test("with reads paused: the hover over a block still shows at once, an erase queued behind a paint applies after it, Import labels waits", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const s = (window as any).__geoapp.imagery();
    const read = s.readWindow.bind(s);
    const g = (window as any).__gate = { open: null as null | (() => void) };
    const wait = new Promise<void>((r) => { g.open = r; });
    s.readWindow = async (...a: unknown[]) => { await wait; return read(...a); };
  });
  const paint = await points(page, 185, 355, 150, 24);
  await drag(page, paint);
  const erase = await points(page, 250, 290, 150, 6);
  await drag(page, erase, "right");
  const over = round(await toScreen(page, lonLat(220.5, 150.5)));
  await page.mouse.move(over.x - 1, over.y);
  await page.mouse.move(over.x, over.y);
  await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
  await expect(page.locator("#import-labels")).toBeDisabled();
  expect((await labels(page)).size).toBe(0);
  await page.evaluate(() => (window as any).__gate.open());
  await settled(page);
  const want = await expected(page, paint, 31);
  for (const k of await expected(page, erase, 31)) want.delete(k);
  expect(new Set((await labels(page)).keys())).toEqual(want);
});
