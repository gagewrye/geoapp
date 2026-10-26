import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page, type Request } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { cogRequests, fetchChip, logRequests, serveAef } from "./aef";
import { drawPolygon, message, openApp, openRaster, rgbFixture, toScreen, type LngLat } from "./helpers";

// Spec 002 criterion 8: what the AlphaEarth fetch sends does not depend on the local raster,
// its labels or its model, and showing or hiding the preview sends nothing.
const FILE = "secret-field-7731.tif";
const CLASSES = ["mangrove-secret-a", "seagrass-secret-b"];

const rect = (page: Page, [w, s, e, n]: number[]) =>
  Promise.all(([[w, n], [e, n], [e, s], [w, s]] as LngLat[]).map((p) => toScreen(page, p)));

/** Open the local raster under FILE, label two classes, train, and return the saved model JSON. */
async function localWork(page: Page): Promise<string> {
  await openRaster(page, { ...rgbFixture(), name: FILE });
  await expect(message(page)).toHaveText("Raster opened.");
  await drawPolygon(page, await rect(page, [11, 43, 13, 46]), CLASSES[0]);
  await drawPolygon(page, await rect(page, [17, 43, 19, 46]), CLASSES[1]);
  await page.click("#train");
  await expect(message(page)).toHaveText(/^Trained on \d+ pixels, 2 classes\.$/);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-model")]);
  return (await readFile((await dl.path())!)).toString("utf8");
}

async function session(browser: Browser, withRaster: boolean) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await serveAef(page);
  const log = logRequests(page);
  await openApp(page);
  const model = withRaster ? await localWork(page) : null;
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  const n = log.length;
  for (let i = 0; i < 2; i++) {
    await page.locator("#aef-preview").uncheck();
    await page.locator("#aef-preview").check();
  }
  await page.waitForTimeout(300);
  const toggled = log.slice(n);
  return { ctx, log, model, toggled };
}

const ranged = (log: Request[]) => cogRequests(log).map((r) => `${r.url()} ${r.headers().range}`).sort();

test("AlphaEarth requests are the same with and without a local raster, and carry none of its data (criterion 8)", async ({ browser, baseURL }) => {
  const plain = await session(browser, false);
  const local = await session(browser, true);

  for (const s of [plain, local]) {
    const remote = s.log.map((r) => r.url()).filter((u) => !u.startsWith("blob:") && !u.startsWith("data:"));
    expect(remote.filter((u) => !u.startsWith(baseURL!) && !u.startsWith(AEF_BASE))).toEqual([]);
    expect(s.log.filter((r) => r.method() !== "GET").map((r) => `${r.method()} ${r.url()}`)).toEqual([]);
    expect(cogRequests(s.log).length).toBeGreaterThan(0);
    expect(s.toggled.map((r) => r.url())).toEqual([]);
  }
  expect(ranged(local.log)).toEqual(ranged(plain.log));

  const secrets = [FILE, ...CLASSES, local.model!, JSON.stringify(JSON.parse(local.model!))];
  for (const r of local.log) {
    const text = [r.url(), JSON.stringify(r.headers()), r.postData() ?? ""].join("\n");
    for (const s of secrets) expect(text.includes(s), `${r.url()} carries ${s.slice(0, 40)}`).toBe(false);
  }
  await plain.ctx.close();
  await local.ctx.close();
});
