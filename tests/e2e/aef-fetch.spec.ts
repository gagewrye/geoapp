import { expect, test, type Page } from "@playwright/test";
import { firstDiff } from "../unit/helpers/floats";
import {
  ATTRIBUTION, cacheFiles, chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, HOST, lonLatBox, logRequests, refChip, serveAef, type Fault,
} from "./aef";
import { holdCogs, serveYears } from "./aefTester";
import { BACKGROUND, hideBasemap, jumpTo, message, openApp, pixelAt, toScreen } from "./helpers";

// Spec 002 criteria 9, 11, 12, 13 and 14 (fetched data), on fixtures (a) and (b).
const bg = [1, 3, 5].map((i) => parseInt(BACKGROUND.slice(i, i + 2), 16));
const isBackground = (px: number[]) => px.slice(0, 3).every((v, i) => Math.abs(v - bg[i]!) <= 3);
const N = chip.width;

/** Bands of the cached AOI over the chip, read through the app's cache source, as base64 Float32. */
function cachedChip(page: Page): Promise<{ bands: string[]; outsideNaN: boolean }> {
  return page.evaluate(async ([cx0, cy1, n]) => {
    const { aoi, source } = (window as any).__geoapp.aef();
    const c0 = (cx0 - aoi.gt[0]) / 10, r0 = (aoi.gt[3] - cy1) / 10;
    const bands = Array.from({ length: 64 }, () => new Float32Array(n * n));
    let outsideNaN = true;
    for (let y = 0; y < aoi.height; y += 256) for (let x = 0; x < aoi.width; x += 256) {
      const w = Math.min(256, aoi.width - x), h = Math.min(256, aoi.height - y);
      const t = await source.readWindow(x, y, w, h);
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const cr = y + r - r0, cc = x + c - c0;
        if (cr >= 0 && cr < n && cc >= 0 && cc < n) for (let b = 0; b < 64; b++) bands[b]![cr * n + cc] = t.bands[b][r * w + c];
        else if (!Number.isNaN(t.bands[0][r * w + c])) outsideNaN = false;
      }
    }
    const b64 = (a: Float32Array) => { let s = ""; const u = new Uint8Array(a.buffer); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!); return btoa(s); };
    return { bands: bands.map(b64), outsideNaN };
  }, [chip.x0, chip.y1, N] as const);
}

const fromB64 = (s: string) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };

test("fetch end-to-end: cache filled, tiles equal the chip, preview toggles, Train and Classify disabled (criteria 9, 11, 14)", async ({ page, baseURL }) => {
  await serveAef(page);
  const log = logRequests(page);
  await openApp(page);
  await hideBasemap(page);
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");

  const aoi = await page.evaluate(() => (window as any).__geoapp.aef().aoi);
  const windows = Math.ceil(aoi.width / 256) * Math.ceil(aoi.height / 256);
  const files = await cacheFiles(page);
  expect(Object.keys(files!).sort()).toEqual(Array.from({ length: 64 }, (_, b) => `b${b}.i8`).sort());
  for (const size of Object.values(files!)) expect(size).toBe(windows * 65536);

  const { bands, outsideNaN } = await cachedChip(page);
  const ref = refChip();
  bands.forEach((b, k) => expect(firstDiff(fromB64(b), ref.subarray(k * N * N, (k + 1) * N * N)), `band ${k}`).toBe(-1));
  expect(outsideNaN).toBe(true);

  // the AOI centre is the chip centre, a valid pixel
  const centre = await toScreen(page, chipCentre);
  await expect(page.locator("#aef-preview")).toBeChecked();
  expect(isBackground(await pixelAt(page, centre))).toBe(false);
  await page.locator("#aef-preview").uncheck();
  expect(isBackground(await pixelAt(page, centre))).toBe(true);
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();
  await page.locator("#aef-preview").check();
  expect(isBackground(await pixelAt(page, centre))).toBe(false);
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();

  await expect(page.locator("#train")).toBeDisabled();
  await expect(page.locator("#classify")).toBeDisabled();

  // criterion 9: from the app origin, only the index beyond static files
  const own = log.map((r) => r.url()).filter((u) => u.startsWith(baseURL!)).map((u) => new URL(u).pathname);
  const nonStatic = own.filter((p) => p !== "/" && !p.startsWith("/assets/") && !p.startsWith("/@") && !p.startsWith("/src/") && !p.startsWith("/node_modules/"));
  expect(new Set(nonStatic)).toEqual(new Set(["/aef-index/years.json", "/aef-index/2021/32617.json"]));
});

test.describe("download failures (criterion 12)", () => {
  // each case makes a fresh Fault, so a counting one starts at 0 in every run
  const cases: { name: string; fault: () => Fault }[] = [
    { name: "a non-206 answer", fault: () => () => 500 },
    { name: "a network error", fault: () => () => "network" },
    { name: "a CORS failure", fault: () => () => "nocors" },
    { name: "a failure after the header", fault: () => { let n = 0; return () => (++n > 3 ? 503 : undefined); } },
  ];
  for (const c of cases) {
    test(`${c.name}: the message names the host, the cache is gone, Train stays disabled, no preview`, async ({ page }) => {
      await serveAef(page, c.fault());
      await openApp(page);
      await fetchChip(page);
      await expect(message(page)).toHaveText(`Couldn't download embeddings from ${HOST}.`);
      expect(await cacheFiles(page)).toBeNull();
      await expect(page.locator("#train")).toBeDisabled();
      await expect(page.locator("#classify")).toBeDisabled();
      expect(await page.evaluate(() => (window as any).__geoapp.aef())).toBeNull();
      expect(await page.evaluate(() => Boolean((window as any).__geoapp.map.getLayer("aef-preview")))).toBe(false);
      await expect(page.getByText(ATTRIBUTION)).toBeHidden();
    });
  }
});

test("no entries for the area and year: the message, and no COG request (criterion 13)", async ({ page }) => {
  await serveAef(page);
  const log = logRequests(page);
  await openApp(page);
  // 10 m east of the chip, in view: inside the zone's shard, overlapping none of its entries
  const [x0, y0, x1, y1] = [chip.x0 + 10 * N + 10, chip.y1 - 500, chip.x0 + 10 * N + 110, chip.y1];
  await fetchChip(page, "2021", lonLatBox(chip.epsg, [x0, y0, x1, y1], 0));
  await expect(message(page)).toHaveText("No AlphaEarth embeddings here for 2021.");
  expect(cogRequests(log)).toEqual([]);
  expect(await cacheFiles(page)).toBeNull();
  await expect(page.getByText(ATTRIBUTION)).toBeHidden();
});

test("one AlphaEarth operation at a time: a double-clicked first Fetch runs one download, with Fetch and Open AlphaEarth file disabled until it ends", async ({ page }) => {
  await serveAef(page);
  const log = logRequests(page);
  const gate = await holdCogs(page);
  await openApp(page);
  await jumpTo(page, chipCentre, 15);
  await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
  await expect(page.locator("#aef-fetch")).toBeEnabled();
  await page.dblclick("#aef-fetch");
  await expect(message(page)).toHaveText("Downloading embeddings...");
  await expect(page.locator("#aef-fetch")).toBeDisabled();
  await expect(page.locator("#open-aef")).toBeDisabled();
  gate.release();
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(page.locator("#aef-fetch")).toBeEnabled();
  await expect(page.locator("#open-aef")).toBeEnabled();
  const asked = cogRequests(log).map((r) => `${r.url()} ${r.headers().range ?? ""}`);
  expect(new Set(asked).size, "each COG range requested once").toBe(asked.length);
});

test("after a fetch, a newly drawn area says it isn't fetched yet until Fetch is clicked (tester F7)", async ({ page }) => {
  await serveAef(page);
  await openApp(page);
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(page.locator("#aef-info")).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
  await jumpTo(page, chipCentre, 13);
  await drawArea(page, lonLatBox(chip.epsg, chipBox, 200));
  await expect(page.locator("#aef-info")).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617 \(not fetched yet; the loaded data is another area\)$/);
  await page.click("#aef-fetch");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(page.locator("#aef-info")).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
});

test("after a fetch, picking another year says it isn't fetched yet, and picking the loaded year again clears that (tester F11)", async ({ page }) => {
  await serveAef(page);
  await serveYears(page, [2020, 2021]);
  await openApp(page);
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  const info = page.locator("#aef-info");
  await expect(info).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
  await page.selectOption("#aef-year", "2020");
  await expect(info).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617 \(not fetched yet; the loaded data is for 2021\)$/);
  await page.selectOption("#aef-year", "2021");
  await expect(info).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
});

test("while a fetch runs, picking another year says the area isn't fetched yet for it (tester F11)", async ({ page }) => {
  await serveAef(page);
  await serveYears(page, [2020, 2021]);
  const gate = await holdCogs(page);
  await openApp(page);
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Downloading embeddings...");
  await page.selectOption("#aef-year", "2020");
  await expect(page.locator("#aef-info")).toHaveText(/\(not fetched yet; the loaded data is for 2021\)$/);
  gate.release();
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(page.locator("#aef-info")).toHaveText(/\(not fetched yet; the loaded data is for 2021\)$/);
  await page.selectOption("#aef-year", "2021");
  await expect(page.locator("#aef-info")).toHaveText(/^Area: \d+ x \d+ px, EPSG:32617$/);
});
