import { expect, test, type Page, type Request } from "@playwright/test";
import {
  BACKGROUND, hideBasemap, jumpTo, logRequests, message, openApp, openRaster, paintMode, pixelAt, rgbFixture, stroke, toLngLat, toScreen, type LngLat, type Xy,
} from "./helpers";

// Spec 012: the bundled Natural Earth basemap, always shown as the bottom map layer.
const bg = [1, 3, 5].map((i) => parseInt(BACKGROUND.slice(i, i + 2), 16));
const near = (a: number[], b: number[], tol: number) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]!) <= tol);
const ids = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: any) => l.id as string));
const basemapUrl = (page: Page): Promise<string> => page.evaluate(() => (window as any).__geoapp.map.getStyle().sources.basemap.url as string);
const fileName = (url: string) => new URL(url, "http://x/").pathname.split("/").pop()!;
const network = (log: Request[]) => log.map((r) => r.url()).filter((u) => !u.startsWith("data:") && !u.startsWith("blob:"));

test("shown at startup: the Sahara and the Pacific are not the background and differ (criterion 2)", async ({ page }) => {
  await openApp(page);
  const px: number[][] = [];
  for (const p of [[13, 23], [-150, 0]] as LngLat[]) {
    await jumpTo(page, p, 1.5);
    px.push(await pixelAt(page, await toScreen(page, p)));
  }
  for (const p of px) expect(near(p, bg, 3), String(p)).toBe(false);
  expect(px[0]!.slice(0, 3).some((v, i) => Math.abs(v - px[1]![i]!) > 30), `${px[0]} vs ${px[1]}`).toBe(true);
});

/**
 * Up to n points of the view (within 250 px of its centre) where the asset is uniform within 4 px
 * (10 per channel), with the asset's pixel there: ((lon + 180) / 360 x 2048, (1 - mercY / pi) / 2 x 2048).
 */
async function uniformPoints(page: Page, n: number): Promise<{ ll: LngLat; rgb: number[] }[]> {
  const box = (await page.locator("#map canvas").boundingBox())!;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const grid: Xy[] = [];
  for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) grid.push({ x: c.x + i * 45, y: c.y + j * 45 });
  const lls = await toLngLat(page, grid);
  return page.evaluate(async ([lls, n]) => {
    const url = (window as any).__geoapp.map.getStyle().sources.basemap.url;
    const img = new Image();
    img.src = url;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = cv.height = 2048;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const out: { ll: [number, number]; rgb: number[] }[] = [];
    for (const [lon, lat] of lls) {
      const my = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
      const ax = Math.floor(((lon + 180) / 360) * 2048), ay = Math.floor(((1 - my / Math.PI) / 2) * 2048);
      if (ax < 4 || ay < 4 || ax > 2043 || ay > 2043) continue;
      const d = ctx.getImageData(ax - 4, ay - 4, 9, 9).data;
      const mid = [d[40 * 4]!, d[40 * 4 + 1]!, d[40 * 4 + 2]!];
      let uniform = true;
      for (let k = 0; k < 81 && uniform; k++) for (let b = 0; b < 3; b++) if (Math.abs(d[4 * k + b]! - mid[b]!) > 10) uniform = false;
      if (uniform) out.push({ ll: [lon, lat], rgb: mid });
      if (out.length === n) break;
    }
    return out;
  }, [lls, n] as const);
}

// the second runs just below the basemap's maxzoom, the end of the globe-to-Mercator morph (spec 045 amends criterion 3)
const belowMax = (page: Page): Promise<number> => page.evaluate(() => (window as any).__geoapp.map.getLayer("basemap").maxzoom - 0.1);
for (const [label, centre, zoom] of [["zoom 3 globe", [-30, 20], 3], ["BASEMAP_MAXZOOM - 0.1", [-30, 30], null]] as const) {
  test(`placement at ${label}: the rendered pixel matches the asset within 12 per channel (criterion 3)`, async ({ page }) => {
    await openApp(page);
    await jumpTo(page, [...centre], zoom ?? await belowMax(page));
    const pts = await uniformPoints(page, 8);
    expect(pts).toHaveLength(8);
    for (const { ll, rgb } of pts) {
      const got = await pixelAt(page, await toScreen(page, ll));
      expect(near(got, rgb, 12), `${ll}: rendered ${got}, asset ${rgb}`).toBe(true);
    }
  });
}

test("order: background, basemap, then imagery and labels; the opaque preview hides it (criterion 4)", async ({ page }) => {
  await openApp(page);
  expect((await ids(page)).slice(0, 2)).toEqual(["background", "basemap"]);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  await expect.poll(async () => (await ids(page)).some((id) => id.startsWith("label-"))).toBe(true);
  const order = await ids(page);
  expect(order.slice(0, 2)).toEqual(["background", "basemap"]);
  expect(order.indexOf("preview")).toBeGreaterThan(1);
  expect(order.findIndex((id) => id.startsWith("label-"))).toBeGreaterThan(order.indexOf("preview"));
  const p = await toScreen(page, [14.5, 44.5]); // imagery, no labels
  const shown = await pixelAt(page, p);
  await hideBasemap(page);
  expect(await pixelAt(page, p)).toEqual(shown);
});

test("privacy: one request for the basemap, under assets/, the same in two sessions; moving makes none (criterion 5)", async ({ browser, baseURL }) => {
  const urls: string[] = [];
  for (const [i, place] of ([[13, 23], [-120, -40]] as LngLat[]).entries()) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const log = logRequests(page);
    await openApp(page);
    await page.evaluate(() => new Promise<void>((r) => { const { map } = (window as any).__geoapp; if (map.loaded()) r(); else map.once("idle", () => r()); }));
    const name = fileName(await basemapUrl(page));
    expect(name).toMatch(/^basemap.*\.jpg$/);
    const hits = network(log).filter((u) => fileName(u) === name);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.startsWith(`${baseURL}/assets/`)).toBe(true);
    urls.push(hits[0]!);
    // after load, jumps across zoom 1..14 request nothing
    const before = log.length;
    for (let z = 1; z <= 14; z++) await jumpTo(page, [place[0] + z * 0.37 * (i ? -1 : 1), place[1] + z * 0.21], z);
    expect(network(log.slice(before)), `session ${i}`).toEqual([]);
    await ctx.close();
  }
  expect(urls[0]).toBe(urls[1]);
});

test("not hideable: no control names it, and it stays visible, opaque and second through a session (criterion 6)", async ({ page }) => {
  await openApp(page);
  const named = await page.evaluate(() => [...document.querySelectorAll("button, input, select, label, a, [role], [aria-label], [title]")]
    .map((el) => [el.id, el.textContent, el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("name")].join(" "))
    .filter((s) => /base\s*-?\s*map/i.test(s)));
  expect(named).toEqual([]);
  page.on("dialog", (d) => void d.accept());
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
  const a = await toScreen(page, [15.005, 45.005]);
  await stroke(page, [a, { x: a.x + 40, y: a.y }]);
  await page.click("#mode-pan");
  await page.click("#mode-paint");
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  const state = await page.evaluate(() => {
    const { map } = (window as any).__geoapp;
    return { vis: map.getLayoutProperty("basemap", "visibility"), opacity: map.getPaintProperty("basemap", "raster-opacity") };
  });
  expect(state.vis).not.toBe("none");
  expect(state.opacity === undefined || state.opacity === 1).toBe(true);
  expect((await ids(page))[1]).toBe("basemap");
});
