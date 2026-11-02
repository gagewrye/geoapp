import { expect, test, type Page } from "@playwright/test";
import { hideBasemap, hideImagery, jumpTo, message, openApp, openRaster, paintMode, pixelAt, selectClass, settled, stroke, tiledTiff, toScreen, type LngLat } from "./helpers";

// Spec 048 criterion 7: on a 4,608² raster (324 tiles) with 323 tiles stored through the hook, a stroke and a
// smart-select commit both label the last tile with no error; fitted, an un-overlaid tile shows on the preview
// at 0.6, and zoomed in it gets its overlay.
const N = 18, SIDE = N * 256, PX = 0.001;
const fixture = () => tiledTiff("big4326.tif", SIDE, SIDE, 1, (_b, c, r) => 60 + ((c >> 4) + (r >> 4)) % 120, { epsg: 4326, gt: [10, PX, 0, 50, 0, -PX] });
/** Lon/lat of raster pixel (c, r)'s centre. */
const at = (c: number, r: number): LngLat => [10 + (c + 0.5) * PX, 50 - (r + 0.5) * PX];
const LAST = `${(N - 1) * 256},${(N - 1) * 256}`;
const RED = "#ff00ff";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const blend = (over: string, under: number[]) => rgb(over).map((v, i) => 0.6 * v + 0.4 * under[i]!);
const near = (got: number[], want: number[]) => want.every((v, i) => Math.abs(got[i]! - v) <= 3);

/** The stored label at raster pixel (c, r), or null when its tile isn't stored. */
const labelAt = (page: Page, c: number, r: number) => page.evaluate(([c, r]) => {
  const t: Uint8Array | undefined = (window as any).__geoapp.labels.store.tiles.get(`${c - (c % 256)},${r - (r % 256)}`);
  return t ? t[(r % 256) * 256 + (c % 256)]! : null;
}, [c, r] as const);
/** Distinct tile keys with an overlay: a tile of several quads has layers label-<key>-<i> (ADR 0019). */
const overlays = (page: Page) => page.evaluate(() => [...new Set(((window as any).__geoapp.map.getLayersOrder() as string[])
  .filter((id) => id.startsWith("label-")).map((id) => id.slice(6).split("-")[0]!))]);

/** A fake Segmenter (spec 046): one mask, a square of half-width 8 logits around the include point. */
const fakeSegmenter = (page: Page) => page.evaluate(() => {
  let held: string | null = null;
  (window as any).__geoapp.segmenter = {
    async encode(_i: Float32Array, key: string) { held = key; },
    has: (key: string) => held === key,
    async decode(points: Float32Array) {
      const masks = new Float32Array(256 * 256).fill(-1), cx = Math.floor(points[0]! / 4), cy = Math.floor(points[1]! / 4);
      for (let y = cy - 8; y <= cy + 8; y++) for (let x = cx - 8; x <= cx + 8; x++) masks[y * 256 + x] = 1;
      return { masks, scores: new Float32Array([0.9]), side: 256 };
    },
  };
});

test("323 stored tiles: a stroke and a smart commit label the last tile; an un-overlaid tile shows on the preview, then gets its overlay (criterion 7)", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await fakeSegmenter(page);
  await openRaster(page, fixture());
  await expect(message(page)).toHaveText("Raster opened.", { timeout: 60_000 });
  await hideBasemap(page);
  await hideImagery(page);
  const probe = at(128, 128); // tile 0,0: a corner, so never among the 256 nearest a fitted view's centre
  const under = await pixelAt(page, await toScreen(page, probe));

  // every tile but the last, through the hook; a recolour redraws every stored tile
  await page.evaluate((last) => {
    const { store } = (window as any).__geoapp.labels;
    for (let y = 0; y < store.height; y += 256) for (let x = 0; x < store.width; x += 256) {
      if (`${x},${y}` !== last) store.tiles.set(`${x},${y}`, new Uint8Array(65536).fill(1));
    }
  }, LAST);
  await page.locator("#classes .class-colour").first().fill(RED);
  expect(await page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size)).toBe(323);

  // a stroke on the last tile
  const base = (N - 1) * 256;
  await jumpTo(page, at(base + 128, base + 128), 10); // about one source px per screen px
  await paintMode(page);
  await stroke(page, [await toScreen(page, at(base + 40, base + 40)), await toScreen(page, at(base + 80, base + 40))]);
  await settled(page);
  expect(await labelAt(page, base + 60, base + 40)).toBe(1);
  expect(await page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size)).toBe(324);

  // a smart-select commit on it, in class 2
  await selectClass(page, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("m");
  const p = await toScreen(page, at(base + 180, base + 180));
  await page.mouse.click(p.x, p.y);
  await expect(page.locator("#smart-apply")).toBeEnabled();
  await page.keyboard.press("Enter");
  await settled(page);
  await expect(page.locator("#smart-apply")).toBeDisabled();
  expect(await labelAt(page, base + 180, base + 180)).toBe(2);
  await expect(message(page)).not.toHaveClass(/error/);

  // fitted: 256 overlays, none on tile 0,0, whose pixels show on the preview
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await expect.poll(() => overlays(page).then((o) => o.length), { timeout: 60_000 }).toBe(256);
  expect(await overlays(page)).not.toContain("0,0");
  await expect.poll(async () => near(await pixelAt(page, await toScreen(page, probe)), blend(RED, under))).toBe(true);

  // zoomed in, it gets its overlay, in the same colour (with the basemap and imagery hidden, the ground is one flat colour)
  await jumpTo(page, probe, 12);
  await expect.poll(() => overlays(page), { timeout: 30_000 }).toContain("0,0");
  await expect.poll(async () => near(await pixelAt(page, await toScreen(page, probe)), blend(RED, under))).toBe(true);
  expect((await overlays(page)).length).toBeLessThanOrEqual(256);
});
