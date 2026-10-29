import { expect, test, type Page } from "@playwright/test";
import { fromLonLat } from "../../src/core/crs";
import { footprint, footprintRing, pixelAt, strokeCells } from "../../src/core/pixel";
import type { Grid } from "../../src/core/types";
import { collectErrors, hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, pixelAt as screenPixel, settled, tiff, toLngLat, toScreen, type LngLat, type Xy } from "./helpers";

// Tester: spec 003 "180 and MAX_LAT": longitude is normalised so every world copy hits the same pixel.
// An EPSG:32660 raster straddling 180 (zone 60 opens, spec 001 criterion 16): strokes and hover across
// the meridian, and painting while the map centre sits in another world copy.

const [X0, Y0] = fromLonLat(32660, 179.6, 10.02);
const GRID: Grid = { width: 3000, height: 120, epsg: 32660, gt: [X0, 30, 0, Y0, 0, -30] }; // 90 km: to about 179.58W
const fixture = () => tiff("z60.tif", GRID.width, GRID.height, 2, (b, c, r) => (b === 0 ? (c < 1500 ? 30 : 120) : (c + r) % 60), { epsg: 32660, gt: GRID.gt });
const round = (p: Xy): Xy => ({ x: Math.round(p.x), y: Math.round(p.y) });
const col180 = Math.floor((fromLonLat(32660, 180, 10)[0] - X0) / 30);

async function setup(page: Page, centreLon: number) {
  await openApp(page);
  await openRaster(page, fixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [centreLon, 9.9995], 12);
}

/** Pixels under the size-7 footprints of the stroke through these cells. */
function covered(cells: [number, number][]): Set<string> {
  const out = new Set<string>();
  cells.flatMap((c, i) => (i === 0 ? [c] : strokeCells(cells[i - 1]!, c))).forEach(([c, r]) => {
    const w = footprint(GRID, c, r, 7);
    if (w) for (let y = w.y0; y < w.y0 + w.height; y++) for (let x = w.x0; x < w.x0 + w.width; x++) out.add(`${x},${y}`);
  });
  return out;
}

async function strokeAcross(page: Page, west: number, east: number) {
  const a = round(await toScreen(page, [west, 9.9995])), b = round(await toScreen(page, [east, 9.9995]));
  const pts = Array.from({ length: 9 }, (_, i) => round({ x: a.x + ((b.x - a.x) * i) / 8, y: a.y }));
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await settled(page);
  return pts;
}

test("a stroke across 180 labels one continuous run of columns through the meridian, and is drawn east of it", async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page, 180);
  expect(col180).toBeGreaterThan(100);
  expect(col180).toBeLessThan(GRID.width - 100);
  const probe = round(await toScreen(page, [180.004, 9.9995]));
  const before = await screenPixel(page, probe);
  const pts = await strokeAcross(page, 179.99, 180.01);
  const lls = await toLngLat(page, pts);
  expect(lls.some(([lon]) => lon > 180)).toBe(true); // the app really unprojected past 180
  const cells = lls.map(([lon, lat]) => pixelAt(GRID, lon, lat));
  const got = new Set((await labels(page)).keys());
  expect(got).toEqual(covered(cells));
  const cols = new Set([...got].map((k) => Number(k.split(",")[0])));
  const lo = Math.min(...cols), hi = Math.max(...cols);
  expect(lo).toBeLessThan(col180);
  expect(hi).toBeGreaterThan(col180);
  expect(cols.size).toBe(hi - lo + 1);
  await expect.poll(async () => (await screenPixel(page, probe)).slice(0, 3)).not.toEqual(before.slice(0, 3));
  expect(errors).toEqual([]);
});

test("the hover east of 180 is footprintRing at the normalised pointer pixel", async ({ page }) => {
  await setup(page, 180);
  const p = round(await toScreen(page, [180.003, 9.9995]));
  await page.mouse.move(p.x - 1, p.y);
  await page.mouse.move(p.x, p.y);
  await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
  const [ll] = await toLngLat(page, [p]);
  const cell = pixelAt(GRID, ll![0] - 360, ll![1]); // the same pixel from the -179.997 copy
  expect(cell).toEqual(pixelAt(GRID, ...ll!));
  expect(cell[0]).toBeGreaterThan(col180);
  const want = footprintRing(GRID, footprint(GRID, cell[0], cell[1], 7)!);
  const ring: LngLat[] = (await hoverFeatures(page))[0].geometry.coordinates[0];
  ring.forEach(([lon, lat], i) => { expect(Math.abs(lon - want[i]![0])).toBeLessThan(1e-6); expect(Math.abs(lat - want[i]![1])).toBeLessThan(1e-6); });
});

test("the same screen stroke with the map centred one world copy east (lon 540) labels the same pixels", async ({ page }) => {
  await setup(page, 180);
  const a = await strokeAcross(page, 179.995, 180.005);
  const first = new Set((await labels(page)).keys());
  expect(first.size).toBeGreaterThan(0);
  await page.evaluate(() => { for (const [, t] of (window as any).__geoapp.labels.store.tiles) t.fill(0); (window as any).__geoapp.labels.store.tiles.clear(); });
  await jumpTo(page, [540, 9.9995], 12);
  const lls = await toLngLat(page, a);
  const copyLon = lls[0]![0];
  test.skip(Math.abs(copyLon - 179.995) < 1, `MapLibre wrapped the centre back (unproject gave ${copyLon}); no world copy to test`);
  await page.mouse.move(a[0]!.x, a[0]!.y);
  await page.mouse.down();
  for (const p of a.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await settled(page);
  expect(new Set((await labels(page)).keys())).toEqual(first);
});
