import { expect, test, type Page } from "@playwright/test";
import { classFile, writeFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, rgbFixture } from "./helpers";
import { importFile, storeTiles, upload } from "./seeding";

// Tester check that seeded labels are ordinary spec 003 labels on the map: one overlay per stored
// tile after an import, removed when a Replace drops the tile, and painted in the class colours.

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const overlayIds = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: { id: string }) => l.id).filter((id: string) => id.startsWith("label-")).sort());
const wanted = async (page: Page) => [...(await storeTiles(page)).keys()].map((k) => `label-${k}`).sort();

/** RGBA counts of an overlay canvas: how many opaque pixels have exactly the given colour. */
const opaqueOf = (page: Page, id: string, hex: string) => page.evaluate(([id, hex]) => {
  const c = (window as any).__geoapp.map.getSource(id).canvas as HTMLCanvasElement;
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let n = 0, opaque = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) { opaque++; if (d[i] === r && d[i + 1] === g && d[i + 2] === b) n++; }
  return { n, opaque };
}, [id, hex] as const);

test("an import adds one overlay per stored tile in the class colours; a smaller Replace removes the dropped ones; a recolour repaints", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  const first = await wanted(page);
  expect(first.length).toBeGreaterThan(4);
  await expect.poll(() => overlayIds(page)).toEqual(first);
  const id = first[Math.floor(first.length / 2)]!;
  const colours: string[] = await page.evaluate(() => (window as any).__geoapp.labels.classes.map((c: { colour: string }) => c.colour));
  const counts = await Promise.all(colours.map((c) => opaqueOf(page, id, c)));
  expect(counts.reduce((s, c) => s + c.n, 0)).toBe(counts[0]!.opaque); // every opaque pixel has a class colour
  expect(counts.filter((c) => c.n > 0).length).toBeGreaterThan(1);

  await page.locator("#classes .class-colour").nth(0).fill("#ff00ff");
  await expect.poll(async () => (await opaqueOf(page, id, "#ff00ff")).n).toBe(counts[0]!.n);

  // Replace with a 10 x 10 km file near 15E 45N (a couple of tiles)
  const small = writeFile({ width: 10, height: 10, epsg: 32633, gt: [500000, 1000, 0, 4990000, 0, -1000] }, 1, new Uint8Array(100).fill(3));
  await page.selectOption("#seed-mode", "replace");
  page.once("dialog", (d) => void d.accept());
  await importFile(page, upload("small.tif", small));
  await expect(message(page)).toHaveText(seeded);
  const second = await wanted(page);
  expect(second.length).toBeLessThan(first.length);
  await expect.poll(() => overlayIds(page)).toEqual(second);
});
