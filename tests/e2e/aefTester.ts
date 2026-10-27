import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { AEF_BASE, type AefEntry } from "../../src/core/aef";
import { ATTRIBUTION, cacheFiles, chip } from "./aef";

// Shared by the spec 002 tester e2e files: holding COG answers, and checking the loaded cache.
const N = chip.width;
const FIX = "tests/fixtures/aef";
const west = (JSON.parse(readFileSync(`${FIX}/aef-index/2021/32617.json`, "utf8")) as AefEntry[])[0]!;

/** The west fixture (a) COG, as a file to open (64 px wide). */
export const westFile = () => ({ name: "west.tiff", mimeType: "image/tiff", buffer: readFileSync(`${FIX}/cogs/${west.path}`) });

/** Whether the OPFS cache holds exactly 64 band files of (window count x 64 KiB) for the loaded AOI. */
export async function files64(page: Page) {
  const f = await cacheFiles(page);
  const aoi = await page.evaluate(() => (window as any).__geoapp.aef()?.aoi);
  if (!f || !aoi) return { ok: false, f, aoi };
  const want = Math.ceil(aoi.width / 256) * Math.ceil(aoi.height / 256) * 65536;
  return { ok: Object.keys(f).length === 64 && Object.values(f).every((s) => s === want), f, aoi };
}

/** Hold every COG answer until release(); the requests themselves are still sent and logged. */
export async function holdCogs(page: Page): Promise<{ release: () => void; held: () => number }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let n = 0;
  // registered after serveAef, so it runs first and falls back to serveAef's handler
  await page.route(`${AEF_BASE}**`, async (route) => { n++; await gate; await route.fallback(); });
  return { release: () => open(), held: () => n };
}

/** Serve this years.json instead of the fixture's. */
export async function serveYears(page: Page, years: number[]): Promise<void> {
  await page.route("**/aef-index/years.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(years) }));
}

/**
 * Bands of the loaded AlphaEarth data over the chip, compared in the page to the reference chip
 * (base64 Int8, dequantized there): the number of mismatching values, and whether every pixel
 * outside the chip is NaN.
 */
export async function chipMismatches(page: Page, refI8: Buffer): Promise<{ mismatches: number; outsideNaN: boolean; aoi: unknown }> {
  return page.evaluate(async ([cx0, cy1, n, b64]) => {
    const raw = atob(b64);
    const q = new Int8Array(raw.length);
    for (let i = 0; i < raw.length; i++) q[i] = (raw.charCodeAt(i) << 24) >> 24;
    const deq = (v: number) => (v === -128 ? NaN : Math.fround((v * Math.abs(v)) / (127.5 * 127.5)));
    const cur = (window as any).__geoapp.aef();
    if (!cur) return { mismatches: -1, outsideNaN: false, aoi: null };
    const { aoi, source } = cur;
    const c0 = (cx0 - aoi.gt[0]) / 10, r0 = (aoi.gt[3] - cy1) / 10;
    let mismatches = 0, outsideNaN = true;
    for (let y = 0; y < aoi.height; y += 256) for (let x = 0; x < aoi.width; x += 256) {
      const w = Math.min(256, aoi.width - x), h = Math.min(256, aoi.height - y);
      const t = await source.readWindow(x, y, w, h);
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const cr = y + r - r0, cc = x + c - c0;
        const inChip = cr >= 0 && cr < n && cc >= 0 && cc < n;
        for (let b = 0; b < 64; b++) {
          const v = t.bands[b][r * w + c];
          if (inChip) { const want = deq(q[b * n * n + cr * n + cc]!); if (!(Object.is(v, want) || (Number.isNaN(v) && Number.isNaN(want)))) mismatches++; }
          else if (!Number.isNaN(v)) outsideNaN = false;
        }
      }
    }
    return { mismatches, outsideNaN, aoi };
  }, [chip.x0, chip.y1, N, refI8.toString("base64")] as const);
}

/** The loaded data is the chip, cached as 64 good band files, with the preview and attribution shown. */
export async function chipLoaded(page: Page) {
  const f = await files64(page);
  expect(f.ok, JSON.stringify(f)).toBe(true);
  expect((await chipMismatches(page, readFileSync(`${FIX}/ref_chip.i8`))).mismatches).toBe(0);
  await expect(page.locator("#aef-preview")).toBeChecked();
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();
}

/** Wait until no request has been made for `ms`, so every task the page started has finished. */
export async function quiet(page: Page, log: unknown[], ms = 1500): Promise<string> {
  let n = -1;
  while (n !== log.length) { n = log.length; await page.waitForTimeout(ms); }
  return (await page.locator("#message").textContent()) ?? "";
}

/**
 * Hold every OPFS removeEntry (the cache's discard and its drop of an earlier cache) while the page's
 * `__holdRemove` is set, so a test can act while a previous cache is still being unloaded.
 */
export async function holdRemoves(page: Page): Promise<{ hold: () => Promise<void>; release: () => Promise<void>; held: () => Promise<number> }> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__removesHeld = 0;
    const orig = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (this: FileSystemDirectoryHandle, ...a: Parameters<typeof orig>) {
      if (w.__holdRemove) { w.__removesHeld++; await w.__holdRemove; }
      return orig.apply(this, a);
    };
  });
  return {
    hold: () => page.evaluate(() => { const w = window as any; w.__holdRemove = new Promise<void>((r) => { w.__releaseRemove = r; }); }),
    release: () => page.evaluate(() => { const w = window as any; w.__holdRemove = undefined; w.__releaseRemove?.(); }),
    held: () => page.evaluate(() => (window as any).__removesHeld as number),
  };
}

/** Whether some tab holds the AlphaEarth cache lock, as seen from `page`. */
export const lockHeld = (page: Page) => page.evaluate(async () => (await navigator.locks.query()).held?.some((l) => l.name === "geoapp:opfs/aef-cache") ?? false);

/** Wait until no tab holds the cache lock: the browser releases a closed or unloaded page's locks a little later. */
export async function lockReleased(page: Page): Promise<void> {
  await expect.poll(() => lockHeld(page), "the closed or unloaded holder's lock is released").toBe(false);
}
