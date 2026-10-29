import { expect, test, type Page } from "@playwright/test";
import { classFile, writeFile } from "../unit/helpers/labelFiles";
import { message, openApp, openRaster, rgbFixture } from "./helpers";
import { importFile, upload } from "./seeding";

// Tester check that imported labels show on the map, updated for spec 014: an import adds no tile
// overlay but one "mask" layer in the class colours, a recolour repaints it, and a Replace swaps it.

const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const overlayIds = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: { id: string }) => l.id).filter((id: string) => id.startsWith("label-")).sort());

/** How many opaque pixels of the mask canvas have exactly the given colour, and how many are opaque. */
const opaqueOf = (page: Page, hex: string) => page.evaluate((hex) => {
  const c = (window as any).__geoapp.map.getSource("mask").canvas as HTMLCanvasElement;
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let n = 0, opaque = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) { opaque++; if (d[i] === r && d[i + 1] === g && d[i + 2] === b) n++; }
  return { n, opaque };
}, hex);

test("an import adds the mask layer in the class colours and no tile overlay; a recolour repaints it; a Replace swaps it", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, upload("classes.tif", classFile("255")));
  await expect(message(page)).toHaveText(seeded);
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getLayer("mask") !== undefined)).toBe(true);
  expect(await overlayIds(page)).toEqual([]);
  const colours: string[] = await page.evaluate(() => (window as any).__geoapp.labels.classes.map((c: { colour: string }) => c.colour));
  const counts = await Promise.all(colours.map((c) => opaqueOf(page, c)));
  expect(counts.reduce((s, c) => s + c.n, 0)).toBe(counts[0]!.opaque); // every opaque pixel has a class colour
  expect(counts.filter((c) => c.n > 0).length).toBe(3);

  await page.locator("#classes .class-colour").nth(0).fill("#ff00ff");
  await expect.poll(async () => (await opaqueOf(page, "#ff00ff")).n).toBe(counts[0]!.n);

  // Replace with a 10 x 10 km file near 15E 45N: a much smaller mask
  const small = writeFile({ width: 10, height: 10, epsg: 32633, gt: [500000, 1000, 0, 4990000, 0, -1000] }, 1, new Uint8Array(100).fill(3));
  await message(page).evaluate((e) => { e.textContent = ""; }); // the first import's message matches too
  page.once("dialog", (d) => void d.accept());
  await importFile(page, upload("small.tif", small));
  await expect(message(page)).toHaveText(seeded);
  await expect.poll(() => page.evaluate(() => (window as any).__geoapp.map.getSource("mask") !== undefined)).toBe(true); // added next frame
  const colour: string = await page.evaluate(() => (window as any).__geoapp.labels.classes[0].colour);
  await expect.poll(async () => (await opaqueOf(page, colour)).opaque).toBeLessThan(counts[0]!.opaque / 10);
  expect((await opaqueOf(page, colour)).opaque).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.filter((l: { id: string }) => l.id === "mask").length)).toBe(1);
  expect(await overlayIds(page)).toEqual([]);
});
