import { readFileSync } from "node:fs";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { cogRequests, logRequests, serveAef } from "./aef";
import { chipMismatches, files64 } from "./aefTester";
import { message, openApp } from "./helpers";

// Shared by the aef-tabs*.tester e2e files (tester re-verification of F10): instrumented tabs of one context.
export const REF = readFileSync("tests/fixtures/aef/ref_chip.i8");
export const loaded = (p: Page) => p.evaluate(() => (window as any).__geoapp.aef()?.aoi ?? null);

/** Count this page's Web Locks requests, and let a test make the next one reject or the next OPFS root lookup fail. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__lockRequests = 0;
    const request = LockManager.prototype.request as (...a: unknown[]) => Promise<unknown>;
    LockManager.prototype.request = function (this: LockManager, ...a: unknown[]) {
      w.__lockRequests++;
      if (w.__failLock) { w.__failLock = false; return Promise.reject(new DOMException("locks refused", "SecurityError")); }
      return request.apply(this, a);
    } as typeof LockManager.prototype.request;
    const getDirectory = StorageManager.prototype.getDirectory;
    StorageManager.prototype.getDirectory = function (this: StorageManager) {
      if (w.__failRoot) { w.__failRoot = false; return Promise.reject(new DOMException("no OPFS", "SecurityError")); }
      return getDirectory.apply(this);
    };
  });
}
export const lockRequests = (p: Page) => p.evaluate(() => (window as any).__lockRequests as number);

export async function pages(context: BrowserContext, n: number): Promise<Page[]> {
  const out: Page[] = [];
  for (let i = 0; i < n; i++) {
    const p = await context.newPage();
    await instrument(p);
    await serveAef(p);
    out.push(p);
  }
  for (const p of out) await openApp(p);
  return out;
}

export async function fetchedOk(p: Page): Promise<void> {
  await expect(message(p)).toHaveText("Embeddings downloaded.");
  expect((await chipMismatches(p, REF)).mismatches).toBe(0);
  expect((await files64(p)).ok, "64 band files of the right size, nothing else").toBe(true);
}

/** `p` is refused: the message, no COG request, nothing loaded, Fetch usable again. */
export async function refused(p: Page): Promise<void> {
  const log = logRequests(p);
  await p.click("#aef-fetch");
  await expect(message(p)).toHaveText(MESSAGES.aefOtherTab);
  expect(cogRequests(log)).toEqual([]);
  await expect(p.locator("#aef-fetch")).toBeEnabled();
}
