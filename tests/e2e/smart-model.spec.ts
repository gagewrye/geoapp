import { expect, test, type Page } from "@playwright/test";
import { MODEL_CACHE } from "../../src/io/modelCache";
import { MODEL_URLS } from "../../src/io/segmenter";
import { MESSAGES } from "../../src/ui/messages";
import { logRequests, message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 055 criteria 7 and 9: Hugging Face answers with an HTML page where a model file should be.

/** A WebGPU adapter with shader-f16, so ensure() goes on to the download. */
const stubGpu = (page: Page) => page.addInitScript(() => {
  const gpu = { requestAdapter: async () => ({ features: { has: (f: string) => f === "shader-f16" } }) };
  Object.defineProperty(Navigator.prototype, "gpu", { get: () => gpu, configurable: true });
});

test("an HTML 200 for the model: one popup, a console error, the mode kept, nothing cached, and only the HF GETs cross-origin (criteria 7, 9)", async ({ page, baseURL }) => {
  await stubGpu(page);
  // Every model URL is routed, though loadSegmenter stops at the first, so nothing reaches the network
  for (const url of MODEL_URLS) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "x".repeat(4271), headers: { "access-control-allow-origin": "*" } }));
  }
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const dialogs: { type: string; text: string }[] = [];
  page.on("dialog", (d) => { dialogs.push({ type: d.type(), text: d.message() }); void d.accept(); });
  const log = logRequests(page);

  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("m");
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs).toEqual([{ type: "confirm", text: MESSAGES.smartDownload }, { type: "alert", text: MESSAGES.smartUnavailable }]);
  await expect.poll(() => errors.some((e) => e.startsWith("Smart select:") && e.includes("4271 bytes"))).toBe(true);
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mode-smart")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#mode-smart")).toBeEnabled();
  await expect(message(page)).not.toHaveClass(/error/);
  expect(await page.evaluate(async (name) => (await (await caches.open(name)).keys()).length, MODEL_CACHE)).toBe(0);

  const app = new URL(baseURL!).origin;
  const cross = log.filter((r) => !/^(data|blob):/.test(r.url()) && new URL(r.url()).origin !== app);
  expect(cross.length).toBeGreaterThan(0);
  for (const r of cross) {
    expect(MODEL_URLS, r.url()).toContain(r.url());
    expect(r.method()).toBe("GET");
    const h = await r.allHeaders();
    expect(h["referer"], r.url()).toBeUndefined();
    expect(h["cookie"], r.url()).toBeUndefined();
  }
});
