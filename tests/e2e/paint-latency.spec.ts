import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { uint8Tiff } from "../unit/helpers/tiffFixtures";
import { jumpTo, message, openApp, paintMode, settled, toScreen, type Xy } from "./helpers";
import { storeTiles } from "./seeding";

// Spec 023 criterion 9: after the background mask reads finish, a 2,000 px size-127 stroke on a 4,096² RGBA
// file of 1-row strips reads no imagery, pushes one PaintOp per pointer move, and labels exactly what F6 off does.

const N = 4096, STEP = 0.002;
const transparent = (c: number, r: number) => c < 512 || Math.abs(c - r) < 40;
/** 64 MiB, past setInputFiles' 50 MB buffer limit, so it goes through a file. */
const fixture = () => (
  Buffer.from(uint8Tiff([{ width: N, height: N, bands: 4, layout: { rows: 1 }, extraSamples: [2],
    value: (k, c, r) => (transparent(c, r) ? 0 : k === 3 ? 255 : 60 + ((c >> 4) + (r >> 4) + 30 * k) % 150) }], { epsg: 4326, gt: [10, STEP, 0, 50, 0, -STEP] })));
const at = (c: number, r: number): [number, number] => [10 + c * STEP, 50 - r * STEP];

/** Down at the first point, a move to each later point, up: returns the pointer events sent (down + moves). */
async function stroke(page: Page, pts: Xy[]): Promise<number> {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await settled(page);
  return pts.length;
}

test("a 2,000 px size-127 stroke after the background reads: no imagery read, one op per move, tiles as with F6 off", async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__reads = 0;
    w.__geoapp.rasterFile = (src: any) => {
      for (const m of ["readSamples", "readWindow"]) {
        const f = src[m].bind(src);
        src[m] = (...a: unknown[]) => { w.__reads++; return f(...a); };
      }
    };
    w.__ops = 0;
    w.__geoapp.paintOp = () => { w.__ops++; };
  });
  const path = test.info().outputPath("rgba4096.tif");
  await writeFile(path, fixture());
  await page.setInputFiles("#open-raster", path);
  await expect(message(page)).toHaveText("Raster opened.", { timeout: 120_000 });
  await paintMode(page);
  await page.locator("#brush-size-range").fill("127");
  await expect(page.locator("#brush-size")).toHaveText("Brush: 127 px");
  await jumpTo(page, at(2048, 2048), 7); // the whole stroke on the map canvas, right of the panel
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.masksDone()), { timeout: 120_000, intervals: [500] }).toBe(true);

  const a = await toScreen(page, at(1000, 1400)), b = await toScreen(page, at(3000, 2600));
  const pts: Xy[] = Array.from({ length: 41 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / 40, y: a.y + ((b.y - a.y) * i) / 40 + (i % 2 ? 6 : 0) }));
  const run = async () => {
    await page.evaluate(() => { (window as any).__reads = 0; (window as any).__ops = 0; });
    const moves = await stroke(page, pts);
    return { moves, reads: await page.evaluate(() => (window as any).__reads), ops: await page.evaluate(() => (window as any).__ops), tiles: await storeTiles(page) };
  };

  const swept = await run();
  expect(swept.reads).toBe(0);
  expect(swept.ops).toBe(swept.moves);
  expect(swept.tiles.size).toBeGreaterThan(10);

  await page.click("#undo");
  expect((await storeTiles(page)).size).toBe(0);
  await page.evaluate(() => { (window as any).__geoapp.sweep = false; });
  const perCell = await run();
  expect(perCell.reads).toBe(0);
  expect(perCell.ops).toBeGreaterThan(1500); // one op per stroke cell
  expect([...perCell.tiles.keys()].sort()).toEqual([...swept.tiles.keys()].sort());
  for (const [k, t] of swept.tiles) expect(Buffer.from(t).equals(Buffer.from(perCell.tiles.get(k)!)), k).toBe(true);
});
