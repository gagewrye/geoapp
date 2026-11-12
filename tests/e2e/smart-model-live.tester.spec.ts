import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Page, type Request } from "@playwright/test";
import { MODEL_URLS } from "../../src/io/segmenter";
import { MESSAGES } from "../../src/ui/messages";
import { message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 055 criterion 10, scripted: Google Chrome (real WebGPU), a fresh profile, the real network, no public/models/
// weights. It downloads about 80 MB from Hugging Face, so it runs only with LIVE_HF=1.
test.skip(!process.env.LIVE_HF, "set LIVE_HF=1 to download the real model from Hugging Face");

test("a fresh profile's first Smart press downloads from Hugging Face and gives a mask; a reload requests no model file", async ({ baseURL }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), "geoapp-live-"));
  const open = () => chromium.launchPersistentContext(dir, { channel: "chrome", headless: !process.env.HEADED, args: ["--enable-unsafe-webgpu"], baseURL, viewport: { width: 1024, height: 768 } });
  const record = (page: Page) => {
    const reqs: Request[] = [];
    page.on("request", (r) => reqs.push(r));
    return reqs;
  };
  const press = async (page: Page, dialogs: string[]) => {
    page.on("dialog", (d) => { dialogs.push(`${d.type()}: ${d.message()}`); void d.accept(); });
    await openApp(page);
    await openRaster(page, rgbFixture());
    await expect(message(page)).toHaveText("Raster opened.");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("m");
    // fail fast on the popup rather than wait out the download timeout
    await expect.poll(async () => dialogs.some((d) => d.startsWith("alert")) ? "popup" : await page.locator("#mode-smart").getAttribute("aria-pressed"),
      { timeout: 540_000 }).toBe("true");
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#smart-apply")).toBeEnabled({ timeout: 60_000 });
  };
  try {
    let ctx = await open();
    let page = ctx.pages()[0] ?? await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    let reqs = record(page);
    const dialogs: string[] = [];
    try { await press(page, dialogs); } finally { console.log("LIVE first errors", JSON.stringify(errors.map((e) => e.slice(0, 400)))); }
    expect(dialogs).toEqual([`confirm: ${MESSAGES.smartDownload}`]);
    const model = reqs.filter((r) => !r.url().startsWith(baseURL!) && !/^(data|blob):/.test(r.url()));
    const hosts = [...new Set(model.map((r) => new URL(r.url()).host))];
    const report = await Promise.all(model.map(async (r) => ({ url: r.url().split("?")[0], status: (await r.response())?.status(), from: r.redirectedFrom()?.url().split("/").pop(), referer: (await r.allHeaders())["referer"] ?? null })));
    console.log("LIVE hosts", JSON.stringify(hosts));
    console.log("LIVE requests", JSON.stringify(report, null, 1));
    console.log("LIVE errors", JSON.stringify(errors));
    for (const u of MODEL_URLS) expect(model.map((r) => r.url())).toContain(u);
    for (const r of report) expect(r.referer).toBeNull();
    await ctx.close();

    ctx = await open();
    page = ctx.pages()[0] ?? await ctx.newPage();
    reqs = record(page);
    const again: string[] = [];
    await press(page, again);
    expect(again).toEqual([]);
    const after = reqs.filter((r) => !r.url().startsWith(baseURL!) && !/^(data|blob):/.test(r.url()));
    console.log("LIVE reload cross-origin", JSON.stringify(after.map((r) => r.url())));
    expect(after.filter((r) => /huggingface\.co|hf\.co|models\//.test(r.url()))).toEqual([]);
    await ctx.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
