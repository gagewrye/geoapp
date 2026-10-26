import type { Page } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { chip } from "./aef";

// Shared by the spec 002 tester e2e files: holding COG answers, and checking the loaded cache.
const N = chip.width;

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

/** Wait until no request has been made for `ms`, so every task the page started has finished. */
export async function quiet(page: Page, log: unknown[], ms = 1500): Promise<string> {
  let n = -1;
  while (n !== log.length) { n = log.length; await page.waitForTimeout(ms); }
  return (await page.locator("#message").textContent()) ?? "";
}
