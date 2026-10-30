import { expect, test, type Page } from "@playwright/test";
import { footprint, pixelAt, strokeCells } from "../../src/core/pixel";
import type { Grid } from "../../src/core/types";
import { writeTiff } from "../../src/io/tiffWriter";
import { jumpTo, labels, message, openApp, openRaster, paintMode, settled, tiff, toLngLat, toScreen, type Xy } from "./helpers";

// Tester: spec 003 Strokes at low zoom: no gaps on fast drags over a very wide raster, reads stay
// tile by tile, and a position off the globe lifts the brush with no interpolation across the gap.

/** Pixels under the size-`side` footprints of each lifted-apart segment of cells (null = off the globe). */
function covered(grid: Grid, cells: ([number, number] | null)[], side: number): Set<string> {
  const out = new Set<string>();
  let prev: [number, number] | null = null;
  for (const c of cells) {
    if (!c) { prev = null; continue; }
    for (const [x0, y0] of prev ? strokeCells(prev, c) : [c]) {
      const w = footprint(grid, x0, y0, side);
      if (w) for (let y = w.y0; y < w.y0 + w.height; y++) for (let x = w.x0; x < w.x0 + w.width; x++) out.add(`${x},${y}`);
    }
    prev = c;
  }
  return out;
}

// whole screen pixels, so the cells computed here are the ones the app computes from its pointer events
const round = (p: Xy): Xy => ({ x: Math.round(p.x), y: Math.round(p.y) });

async function setSize(page: Page, px: number) {
  while ((await page.locator("#brush-size").textContent()) !== `Brush: ${px} px`) await page.click("#brush-larger");
}

test("a fast size-127 drag at zoom 4 over a 65792 px wide strip labels every pixel between its ends, reading no imagery", async ({ page }) => {
  test.setTimeout(120_000);
  const parts: Uint8Array[] = [];
  const geo = { GeoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326], ModelPixelScale: [0.005, 0.005, 0], ModelTiepoint: [0, 0, 0, -175, 10, 0] };
  await writeTiff({ write: async (d) => { parts.push(d.slice()); }, close: async () => {} }, 257 * 256, 2, geo, async (w) => new Uint8Array(w.width * w.height).fill(7));
  const grid: Grid = { width: 257 * 256, height: 2, epsg: 4326, gt: [-175, 0.005, 0, 10, 0, -0.005] };
  await openApp(page);
  await openRaster(page, { name: "strip.tif", mimeType: "image/tiff", buffer: Buffer.concat(parts) });
  await expect(message(page)).toHaveText("Raster opened.", { timeout: 30_000 });
  await paintMode(page);
  await setSize(page, 127);
  await jumpTo(page, [-20, 9.995], 4);
  await page.evaluate(() => {
    const s = (window as any).__geoapp.imagery();
    const log = (window as any).__log = { reads: [] as unknown[][], inFlight: 0, max: 0 };
    for (const m of ["readWindow", "readSamples"]) { // spec 023 reads masks with readSamples: gate both
      if (!s[m]) continue;
      const read = s[m].bind(s);
      s[m] = async (...a: unknown[]) => {
        log.reads.push([m, ...a]); log.inFlight++; log.max = Math.max(log.max, log.inFlight);
        try { return await read(...a); } finally { log.inFlight--; }
      };
    }
  });
  const a = round(await toScreen(page, [-35, 9.995])), b = round(await toScreen(page, [-5, 9.995]));
  const pts: Xy[] = [a, round({ x: (a.x + b.x) / 2, y: a.y }), b]; // two moves of ~300 screen px, ~3000 raster px each
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await settled(page);
  const cells = (await toLngLat(page, pts)).map(([lon, lat]) => pixelAt(grid, lon, lat));
  const got = new Set((await labels(page)).keys());
  expect(got.size).toBeGreaterThan(2 * 5000);
  expect(got).toEqual(covered(grid, cells, 127));
  const cols = [...got].map((k) => Number(k.split(",")[0]));
  expect(Math.max(...cols) - Math.min(...cols) + 1).toBe(got.size / 2); // both rows, no gap
  const log = await page.evaluate(() => (window as any).__log);
  expect(log.reads).toEqual([]); // spec 023 F2: a uint8 file with no nodata or alpha has no nodata pixel, so no mask is read
});

test("a stroke that leaves the globe and comes back is lifted: nothing is interpolated across the gap", async ({ page }) => {
  const grid: Grid = { width: 320, height: 280, epsg: 4326, gt: [-80, 0.5, 0, 70, 0, -0.5] };
  await openApp(page);
  await openRaster(page, tiff("wide.tif", 320, 280, 1, (_b, c) => c, { epsg: 4326, gt: grid.gt }));
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [0, 0], 1.5);
  const box = (await page.locator("#map canvas").boundingBox())!;
  const A = round(await toScreen(page, [-29.75, 9.75])), B = round(await toScreen(page, [30.25, 9.75]));
  const tl = { x: box.x + 5, y: box.y + 5 }, tr = { x: box.x + box.width - 5, y: box.y + 5 };
  const pts: Xy[] = [];
  const lerp = (p: Xy, q: Xy, n: number) => { for (let i = 1; i <= n; i++) pts.push(round({ x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n })); };
  pts.push(A); lerp(A, tl, 12); lerp(tl, tr, 6); lerp(tr, B, 12);
  await page.mouse.move(A.x, A.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await settled(page);
  // the cells the app sees: null where the point is off the globe (the same test the brush uses)
  const on: boolean[] = await page.evaluate((pts) => {
    const { map } = (window as any).__geoapp;
    const r = map.getCanvas().getBoundingClientRect();
    const P = map.project([0, 0]).constructor;
    return pts.map((p) => map._camera.transform.isPointOnMapSurface(new P(p.x - r.left, p.y - r.top)));
  }, pts);
  expect(on.filter((v) => !v).length).toBeGreaterThan(5); // really off the globe for a while
  const lls = await toLngLat(page, pts);
  const cells = lls.map(([lon, lat], i) => (on[i] ? pixelAt(grid, lon, lat) : null));
  const got = new Set((await labels(page)).keys());
  expect(got).toEqual(covered(grid, cells, 7));
  // without the lift the exit and re-entry cells would join across the middle of the raster
  const mid = [...got].filter((k) => { const [c] = k.split(",").map(Number) as [number]; return c > 140 && c < 180; });
  expect(mid).toEqual([]);
});
