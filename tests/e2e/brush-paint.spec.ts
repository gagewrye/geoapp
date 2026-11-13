import { expect, test, type Page } from "@playwright/test";
import { footprint, pixelAt, strokeCells } from "../../src/core/pixel";
import { paintMode, RGB_GRID, jumpTo, labels, message, openApp, openRaster, path, rgbFixture, selectClass, stroke, toLngLat, toScreen, view, type Xy } from "./helpers";

// Spec 003 criterion 10: paint and erase on spec 001's EPSG:4326 fixture.

async function setup(page: Page, zoom: number) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], zoom);
}

/** The raster pixels the app computes for these screen points (same unproject, same pixelAt). */
async function cellsOf(page: Page, pts: Xy[]): Promise<[number, number][]> {
  return (await toLngLat(page, pts)).map(([lon, lat]) => pixelAt(RGB_GRID, lon, lat));
}

/** Every pixel under the size-`side` footprints of the stroke through these cells. */
function covered(cells: [number, number][], side = 7): Set<string> {
  const out = new Set<string>();
  const all = cells.flatMap((c, i) => (i === 0 ? [c] : strokeCells(cells[i - 1]!, c)));
  for (const [c, r] of all) {
    const w = footprint(RGB_GRID, c, r, side)!;
    for (let y = w.y0; y < w.y0 + w.height; y++) for (let x = w.x0; x < w.x0 + w.width; x++) out.add(`${x},${y}`);
  }
  return out;
}

const keys = (m: Map<string, number>, v?: number) => new Set([...m].filter(([, x]) => v === undefined || x === v).map(([k]) => k));

test.describe("paint and erase (criterion 10)", () => {
  for (const moves of [20]) {
    test(`zoom 14: a horizontal size-7 left drag (${moves === 2 ? "two moves 300 px apart" : "20 moves"}) labels exactly rows r-3..r+3 from the start column to the end column`, async ({ page }) => {
      await setup(page, 14);
      const v0 = await view(page);
      const box = (await page.locator("#map canvas").boundingBox())!;
      const a = { x: box.x + 60, y: (await toScreen(page, [15, 45.0005])).y };
      const b = { x: a.x + 600, y: a.y }; // inside the 744 px map, about 3 raster pixels
      expect(b.x).toBeLessThan(box.x + box.width);
      const pts = moves === 2 ? [a, { x: a.x + 300, y: a.y }, b] : path(a, b, moves + 1);
      await stroke(page, pts);
      const [[c0, r], [c1, r1]] = (await cellsOf(page, [a, b])) as [[number, number], [number, number]];
      expect(r1).toBe(r);
      expect(c1 - c0).toBeGreaterThanOrEqual(2); // a 0.01 degree pixel is about 200 screen px at zoom 14
      const want = new Set<string>();
      for (let y = r - 3; y <= r + 3; y++) for (let x = c0 - 3; x <= c1 + 3; x++) want.add(`${x},${y}`);
      const got = await labels(page);
      expect(keys(got)).toEqual(want);
      expect(new Set(got.values())).toEqual(new Set([1]));
      expect(await view(page)).toEqual(v0);
    });
  }

  test("zoom 3: a drag of a few moves labels one 8-connected set containing the first and last footprints", async ({ page }) => {
    await setup(page, 3);
    const v0 = await view(page);
    const c = await toScreen(page, [15, 45]);
    const pts = [{ x: c.x - 40, y: c.y - 30 }, { x: c.x - 5, y: c.y + 25 }, { x: c.x + 30, y: c.y - 10 }, { x: c.x + 45, y: c.y + 35 }];
    await stroke(page, pts);
    const got = keys(await labels(page));
    const cells = await cellsOf(page, pts);
    expect(got).toEqual(covered(cells));
    for (const end of [cells[0]!, cells.at(-1)!]) for (const k of covered([end])) expect(got.has(k), k).toBe(true);
    // one 8-connected component
    const seen = new Set<string>();
    const todo = [[...got][0]!];
    while (todo.length) {
      const k = todo.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      const [x, y] = k.split(",").map(Number) as [number, number];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (got.has(`${x + dx},${y + dy}`)) todo.push(`${x + dx},${y + dy}`);
    }
    expect(seen.size).toBe(got.size);
    expect(await view(page)).toEqual(v0);
  });

  test("a right drag clears the selected class and leaves other classes; contextmenu is prevented", async ({ page }) => {
    await setup(page, 14);
    const v0 = await view(page);
    await page.evaluate(() => {
      (window as any).__menus = [];
      window.addEventListener("contextmenu", (e) => (window as any).__menus.push(e.defaultPrevented));
    });
    const a = await toScreen(page, [14.9995, 45.0005]);
    // Kept inside the 1024 px viewport: a release past it fires contextmenu on <html>, off the map (spec 003)
    await stroke(page, [a, { x: a.x + 250, y: a.y }]); // class 1
    await selectClass(page, 1);
    await stroke(page, [{ x: a.x + 120, y: a.y - 300 }, { x: a.x + 120, y: a.y + 300 }]); // class 2 across it
    const before = await labels(page);
    expect(keys(before, 1).size).toBeGreaterThan(0);
    expect(keys(before, 2).size).toBeGreaterThan(0);
    await selectClass(page, 0);
    await stroke(page, [{ x: a.x - 100, y: a.y }, { x: a.x + 350, y: a.y }], "right");
    const after = await labels(page);
    expect(keys(after, 1).size).toBe(0);
    expect(keys(after, 2)).toEqual(keys(before, 2));
    const menus: boolean[] = await page.evaluate(() => (window as any).__menus);
    expect(menus.length).toBeGreaterThan(0);
    expect(menus.every(Boolean)).toBe(true);
    expect(await view(page)).toEqual(v0);
  });
});
