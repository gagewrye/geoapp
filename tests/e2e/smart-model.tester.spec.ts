import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { MODEL_CACHE } from "../../src/io/modelCache";
import { MODEL_FILES, MODEL_URLS } from "../../src/io/segmenter";
import { MESSAGES } from "../../src/ui/messages";
import { logRequests, message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 055 criteria 7-9 and scope 3-4, tester edge cases: a 404, a redirect to a CDN host, stale and wrong-sized cache
// entries, a declined confirm, a retry, and right-sized files that ORT can't load.
const CORS = { "access-control-allow-origin": "*" };

const stubGpu = (page: Page) => page.addInitScript(() => {
  const gpu = { requestAdapter: async () => ({ features: { has: (f: string) => f === "shader-f16" } }) };
  Object.defineProperty(Navigator.prototype, "gpu", { get: () => gpu, configurable: true });
});

/** Dialogs seen, each accepted, or dismissed if it's a confirm and `decline` is set. */
function dialogs(page: Page, decline = false) {
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(`${d.type()}: ${d.message()}`); void (decline && d.type() === "confirm" ? d.dismiss() : d.accept()); });
  return seen;
}

function consoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}

async function ready(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const cacheKeys = (page: Page) => page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url), MODEL_CACHE);

async function modeKept(page: Page) {
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mode-smart")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#mode-smart")).toBeEnabled();
  await expect(message(page)).not.toHaveClass(/error/);
}

const CONFIRM = `confirm: ${MESSAGES.smartDownload}`, ALERT = `alert: ${MESSAGES.smartUnavailable}`;

test("a 404 from Hugging Face: one popup and a console error per press, the mode kept, nothing cached, and a second press retries", async ({ page }) => {
  await stubGpu(page);
  let gets = 0;
  for (const url of MODEL_URLS) await page.route(url, (r) => { gets++; return r.fulfill({ status: 404, body: "Entry not found", headers: CORS }); });
  const seen = dialogs(page), errors = consoleErrors(page);
  await ready(page);
  await page.keyboard.press("m");
  await expect.poll(() => seen).toEqual([CONFIRM, ALERT]);
  await expect.poll(() => errors.filter((e) => e.startsWith("Smart select:")).length).toBe(1);
  expect(errors.find((e) => e.startsWith("Smart select:"))).toContain("404");
  await modeKept(page);
  expect(await cacheKeys(page)).toEqual([]);
  await page.locator("#mode-smart").click();
  await expect.poll(() => seen).toEqual([CONFIRM, ALERT, CONFIRM, ALERT]);
  await expect.poll(() => errors.filter((e) => e.startsWith("Smart select:")).length).toBe(2);
  expect(gets).toBe(2);
  await modeKept(page);
});

test("a redirect to another host that answers HTML: one popup, nothing cached, and neither hop gets a Referer or Cookie", async ({ page, context, baseURL }) => {
  // Playwright doesn't route the hop after a fulfilled redirect, so the hop goes to a local server standing in for
  // Hugging Face's CDN (in production, a *.xethub.hf.co or cdn-lfs host); it records each request's headers
  const hops: Record<string, string | string[] | undefined>[] = [];
  const cdn = createServer((req, res) => {
    hops.push({ ...req.headers, method: req.method });
    res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
    res.end("x".repeat(4271));
  });
  await new Promise<void>((r) => cdn.listen(0, "127.0.0.1", r));
  try {
    const port = (cdn.address() as AddressInfo).port;
    await stubGpu(page);
    await context.addCookies([{ name: "hf", value: "1", domain: "huggingface.co", path: "/" }, { name: "cdn", value: "1", domain: "127.0.0.1", path: "/" }]);
    for (const url of MODEL_URLS) await page.route(url, (r) => r.fulfill({ status: 302, headers: { ...CORS, location: `http://127.0.0.1:${port}/x?f=${encodeURIComponent(url)}` } }));
    const seen = dialogs(page), errors = consoleErrors(page), log = logRequests(page);
    await ready(page);
    await page.keyboard.press("m");
    await expect.poll(() => seen).toEqual([CONFIRM, ALERT]);
    await expect.poll(() => errors.some((e) => e.startsWith("Smart select:") && e.includes("4271 bytes"))).toBe(true);
    await modeKept(page);
    expect(await cacheKeys(page)).toEqual([]);
    expect(hops.length).toBe(1);
    expect(hops[0]!.method).toBe("GET");
    expect(hops[0]!.referer).toBeUndefined();
    expect(hops[0]!.cookie).toBeUndefined();
    const app = new URL(baseURL!).origin;
    const first = log.filter((r) => r.url().startsWith("https://huggingface.co/"));
    expect(first.map((r) => r.url())).toEqual([MODEL_URLS[0]]);
    for (const r of first) {
      const h = await r.allHeaders();
      expect(h["referer"]).toBeUndefined();
      expect(h["cookie"]).toBeUndefined();
    }
    expect(log.filter((r) => !/^(data|blob):/.test(r.url()) && ![app, "https://huggingface.co", `http://127.0.0.1:${port}`].includes(new URL(r.url()).origin))).toEqual([]);
  } finally {
    await new Promise((r) => cdn.close(r));
  }
});

test("stale same-origin and wrong-sized Hugging Face entries: the confirm still shows, the old entry is pruned, and the next press asks again (scope 3)", async ({ page, baseURL }) => {
  await stubGpu(page);
  for (const url of MODEL_URLS) await page.route(url, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "x".repeat(4271), headers: CORS }));
  const seen = dialogs(page);
  await ready(page);
  const old = `${new URL(baseURL!).origin}/models/sam2.1-hiera-tiny/vision_encoder_fp16.onnx`;
  await page.evaluate(async ([name, urls]) => {
    const c = await caches.open(name);
    for (const u of urls) await c.put(u, new Response(new Uint8Array(4271)));
  }, [MODEL_CACHE, [old, ...MODEL_URLS]] as const);
  await page.keyboard.press("m");
  await expect.poll(() => seen).toEqual([CONFIRM, ALERT]);
  await modeKept(page);
  // the old same-origin entry is pruned and the first file's wrong entry deleted; later files' wrong entries are only
  // deleted when reached (scope 3), so they may remain, but must never count as cached
  const left = await cacheKeys(page);
  expect(left).not.toContain(old);
  expect(left).not.toContain(MODEL_URLS[0]);
  await page.keyboard.press("m");
  await expect.poll(() => seen).toEqual([CONFIRM, ALERT, CONFIRM, ALERT]);
});

test("declining the confirm: no request to Hugging Face, no popup, no console error, the mode kept", async ({ page }) => {
  await stubGpu(page);
  const seen = dialogs(page, true), errors = consoleErrors(page), log = logRequests(page);
  await ready(page);
  await page.keyboard.press("m");
  await expect.poll(() => seen).toEqual([CONFIRM]);
  await page.waitForTimeout(300);
  expect(seen).toEqual([CONFIRM]);
  expect(errors.filter((e) => e.startsWith("Smart select:"))).toEqual([]);
  expect(log.filter((r) => r.url().includes("huggingface.co"))).toEqual([]);
  await modeKept(page);
});

test("right-sized files the worker can't use: one popup and a console error, the files cached, and the button state per scope 4", async ({ page }) => {
  test.setTimeout(120_000);
  await stubGpu(page);
  const bodies = new Map(MODEL_FILES.map((f) => [f.url, Buffer.alloc(f.bytes)]));
  for (const url of MODEL_URLS) await page.route(url, (r) => r.fulfill({ status: 200, body: bodies.get(url)!, headers: { ...CORS, "content-type": "application/octet-stream" } }));
  const seen = dialogs(page), errors = consoleErrors(page);
  await ready(page);
  await page.keyboard.press("m");
  await expect.poll(() => seen, { timeout: 90_000 }).toEqual([CONFIRM, ALERT]);
  await expect.poll(() => errors.filter((e) => e.startsWith("Smart select:")).length).toBe(1);
  const inWorker = errors.find((e) => e.startsWith("Smart select:"))!.includes("in the worker");
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(message(page)).not.toHaveClass(/error/);
  // the init script's gpu stub doesn't reach the worker: without real WebGPU there, the button is disabled (scope 4);
  // with it, ORT fails on the zero bytes and the button stays enabled
  if (inWorker) {
    await expect(page.locator("#mode-smart")).toBeDisabled();
    await expect(page.locator("#mode-smart")).toHaveAttribute("title", MESSAGES.smartUnavailable);
  } else await expect(page.locator("#mode-smart")).toBeEnabled();
  // right-sized bytes pass the size check by design (spec 055: no sha256), so they stay cached
  expect((await cacheKeys(page)).sort()).toEqual([...MODEL_URLS].sort());
  if (inWorker) return;
  await page.keyboard.press("m");
  await expect.poll(() => seen, { timeout: 30_000 }).toEqual([CONFIRM, ALERT, ALERT]);
  await modeKept(page);
});
