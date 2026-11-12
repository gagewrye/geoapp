import { expect, test, type Page } from "@playwright/test";
import { footprint, pixelAt, strokeCells } from "../../src/core/pixel";
import type { Grid } from "../../src/core/types";
import { writeTiff } from "../../src/io/tiffWriter";
import { jumpTo, labels, message, openApp, openRaster, paintMode, settled, toLngLat, toScreen, type Xy } from "./helpers";

// Tester: spec 003 Strokes at low zoom: no gaps on fast drags over a very wide raster, and reads stay
// tile by tile.

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
  while ((await page.locator("#brush-size").textContent()) !== `${px}`) await page.click("#brush-larger");
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
