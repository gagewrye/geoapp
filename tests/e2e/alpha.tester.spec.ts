import { expect, test, type Page } from "@playwright/test";
import { uint8Tiff } from "../unit/helpers/tiffFixtures";
import { BACKGROUND, hideBasemap, jumpTo, message, openApp, openRaster, pixelAt, toScreen, type LngLat } from "./helpers";

// Spec 022, tester: transparent pixels show what lies below, in the preview and in the full-resolution tiles.

const EDGE = 100;
const rgba = () => ({
  name: "rgba.tif", mimeType: "image/tiff",
  buffer: Buffer.from(uint8Tiff([{ width: 1000, height: 1000, bands: 4, layout: { rows: 1 }, extraSamples: [2],
    value: (k, c, r) => (c < EDGE ? 0 : k === 3 ? 255 : k === 0 ? 200 + Math.floor(r / 25) : 40 + Math.floor(c / 25)) }], { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] })),
});
const at = (c: number, r: number): LngLat => [10 + c * 0.01, 50 - r * 0.01];
const bg = [1, 3, 5].map((k) => parseInt(BACKGROUND.slice(k, k + 2), 16));
// smooth bands: near (100..140, 519) red stretches to about 130 and green and blue to about 30, so opaque pixels there are red-dominant
const opaque = (a: number[]) => !near(a, bg) && a[0]! > a[1]! && a[0]! > a[2]!;
const near = (a: number[], b: number[]) => a.slice(0, 3).every((v, k) => Math.abs(v - b[k]!) <= 2);
const imagerySources = (page: Page) => page.evaluate(() => Object.keys((window as any).__geoapp.map.getStyle().sources).filter((id) => id.startsWith("imagery-")).length);
/** Shows or hides every layer whose id starts with prefix, including layers added later. */
const setVisible = (page: Page, prefix: string, on: boolean) => page.evaluate(([prefix, on]) => {
  const { map } = (window as any).__geoapp;
  const hidden: Set<string> = (map.__hidden ??= new Set<string>());
  if (on) hidden.delete(prefix as string); else hidden.add(prefix as string);
  if (!map.__patched) {
    map.__patched = true;
    const add = map.addLayer.bind(map);
    map.addLayer = (l: { id: string; layout?: object }, before?: string) =>
      add([...hidden].some((h) => l.id.startsWith(h)) ? { ...l, layout: { ...l.layout, visibility: "none" } } : l, before);
  }
  for (const id of map.getLayersOrder() as string[]) if (id.startsWith(prefix as string)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}, [prefix, on] as const);

test("transparent pixels show the background, not black, in the preview and in the full-resolution tiles", async ({ page }) => {
  await openApp(page);
  await openRaster(page, rgba());
  await expect(message(page)).toHaveText("Raster opened.");
  await hideBasemap(page);
  // the preview alone, zoomed out
  await setVisible(page, "imagery-", false);
  await jumpTo(page, at(EDGE, 519.5), 6);
  expect(near(await pixelAt(page, await toScreen(page, at(EDGE - 40, 519.5))), bg)).toBe(true);
  const pv = await pixelAt(page, await toScreen(page, at(EDGE + 40, 519.5)));
  expect(opaque(pv), String(pv)).toBe(true);
  // full-resolution tiles alone, at about 60 CSS px per source pixel
  await jumpTo(page, at(EDGE, 519.5), 12);
  await expect.poll(() => imagerySources(page), { timeout: 20_000 }).toBeGreaterThan(0);
  await setVisible(page, "preview", false);
  await setVisible(page, "imagery-", true);
  await jumpTo(page, at(EDGE, 519.5), 12);
  expect(near(await pixelAt(page, await toScreen(page, at(EDGE - 1.5, 519.5))), bg)).toBe(true);
  const px = await pixelAt(page, await toScreen(page, at(EDGE + 1.5, 519.5)));
  expect(opaque(px), String(px)).toBe(true);
});
