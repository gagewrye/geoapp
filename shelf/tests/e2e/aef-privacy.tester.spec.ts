import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page, type Request } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { toLonLat } from "../../src/core/crs";
import { chip, cogRequests, fetchChip, logRequests, serveAef } from "./aef";
import { jumpTo, labels, message, openApp, openRaster, path, renameClass, selectClass, stroke, tiff, toScreen, type LngLat } from "./helpers";

// Tester e2e for criterion 8: a local raster over the AOI itself, labels inside the AOI, names
// with characters that would be percent-encoded in a URL, cookies on both hosts, and the Range
// headers themselves (well-formed, each byte asked for once per download).
const FILE = "Fazenda São João #3 & lote=7?.tif";
const CLASSES = ["área protegida/norte", "mangue 100% secreto"];
const N = chip.width;

/** A 3-band 10 m raster in the chip's CRS, 300 m larger than the chip on every side. */
const localRaster = () => tiff(FILE, N + 60, N + 60, 3, (b, c) => (c < (N + 60) / 2 ? 40 : 210) + 5 * b,
  { epsg: chip.epsg, gt: [chip.x0 - 300, 10, 0, chip.y1 + 300, 0, -10] });

/** Screen point of a UTM position at the current view. */
const utm = (page: Page, x: number, y: number) => toScreen(page, toLonLat(chip.epsg, x, y) as LngLat);

async function localWork(page: Page): Promise<string> {
  await openRaster(page, localRaster());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, toLonLat(chip.epsg, chip.x0 + 640, chip.y1 - 640) as LngLat, 15);
  // both classes are painted inside the area that is fetched next
  for (const [i, x] of [chip.x0 + 100, chip.x0 + 800].entries()) {
    await renameClass(page, i, CLASSES[i]!);
    await selectClass(page, i);
    await stroke(page, path(await utm(page, x, chip.y1 - 300), await utm(page, x + 400, chip.y1 - 1000), 10));
  }
  expect(new Set((await labels(page)).values())).toEqual(new Set([1, 2]));
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-model")]);
  return (await readFile((await dl.path())!)).toString("utf8");
}

async function session(browser: Browser, baseURL: string, withLocal: boolean) {
  const ctx = await browser.newContext();
  await ctx.addCookies([
    { name: "aefsecret", value: "c00kie-aef", domain: new URL(AEF_BASE).hostname, path: "/", secure: true },
    { name: "appsecret", value: "c00kie-app", url: baseURL },
  ]);
  const page = await ctx.newPage();
  await serveAef(page);
  const log = logRequests(page);
  await openApp(page);
  const model = withLocal ? await localWork(page) : null;
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  const headers = await Promise.all(log.map((r) => r.allHeaders()));
  return { ctx, log, headers, model };
}

const ranged = (log: Request[]) => cogRequests(log).map((r) => `${r.url()} ${r.headers().range}`).sort();

test("labels inside the AOI and URL-special names change no AlphaEarth request and appear in none (criterion 8, tester)", async ({ browser, baseURL }) => {
  const plain = await session(browser, baseURL!, false);
  const local = await session(browser, baseURL!, true);
  expect(ranged(local.log)).toEqual(ranged(plain.log));

  for (const s of [plain, local]) {
    const cogs = cogRequests(s.log);
    expect(cogs.length).toBeGreaterThan(0);
    // every COG request is a well-formed single range, without cookies, and no byte is asked for twice
    const byUrl = new Map<string, [number, number][]>();
    for (const r of cogs) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(r.headers().range ?? "");
      expect(m, `${r.url()} range ${r.headers().range}`).not.toBeNull();
      const [a, b] = [Number(m![1]), Number(m![2])];
      expect(a).toBeLessThanOrEqual(b);
      byUrl.set(r.url(), [...(byUrl.get(r.url()) ?? []), [a, b]]);
    }
    for (const [url, rs] of byUrl) {
      rs.sort((p, q) => p[0] - q[0]);
      for (let i = 1; i < rs.length; i++) expect(rs[i]![0], `${url}: ${rs[i - 1]} then ${rs[i]}`).toBeGreaterThan(rs[i - 1]![1]);
    }
    s.log.forEach((r, i) => {
      if (r.url().startsWith(AEF_BASE)) expect(s.headers[i]!.cookie, r.url()).toBeUndefined();
    });
  }

  const secrets = [FILE, ...CLASSES, local.model!, JSON.stringify(JSON.parse(local.model!))];
  const forms = (s: string) => [s, encodeURIComponent(s), encodeURI(s), s.replace(/\.tif$/, "")];
  local.log.forEach((r, i) => {
    let decoded = r.url();
    try { decoded = decodeURIComponent(r.url()); } catch { /* keep raw */ }
    const text = [r.url(), decoded, JSON.stringify(local.headers[i]), r.postData() ?? ""].join("\n");
    for (const s of secrets) for (const f of forms(s)) expect(text.includes(f), `${r.url()} carries ${f.slice(0, 40)}`).toBe(false);
  });
  await plain.ctx.close();
  await local.ctx.close();
});
