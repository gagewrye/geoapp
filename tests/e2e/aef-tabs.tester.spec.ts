import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { MESSAGES } from "../../src/ui/messages";
import { chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, logRequests, lonLatBox, serveAef } from "./aef";
import { chipLoaded, chipMismatches, files64, holdCogs, holdRemoves, quiet, westFile } from "./aefTester";
import { jumpTo, message, openApp } from "./helpers";

// Tester re-verification of F10: try to get two tabs onto the AlphaEarth cache at once.
// Web Locks and OPFS are per origin per browser profile. In Playwright a BrowserContext is its own profile,
// so "tabs" here are pages of one context; the last test shows two contexts don't share the lock (or OPFS).
const REF = readFileSync("tests/fixtures/aef/ref_chip.i8");
const loaded = (p: Page) => p.evaluate(() => (window as any).__geoapp.aef()?.aoi ?? null);

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
const lockRequests = (p: Page) => p.evaluate(() => (window as any).__lockRequests as number);
const lockHeld = (p: Page) => p.evaluate(async () => (await navigator.locks.query()).held?.some((l) => l.name === "geoapp:opfs/aef-cache") ?? false);

async function pages(context: BrowserContext, n: number): Promise<Page[]> {
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

async function fetchedOk(p: Page): Promise<void> {
  await expect(message(p)).toHaveText("Embeddings downloaded.");
  expect((await chipMismatches(p, REF)).mismatches).toBe(0);
  expect((await files64(p)).ok, "64 band files of the right size, nothing else").toBe(true);
}

/** `p` is refused: the message, no COG request, nothing loaded, Fetch usable again. */
async function refused(p: Page): Promise<void> {
  const log = logRequests(p);
  await p.click("#aef-fetch");
  await expect(message(p)).toHaveText(MESSAGES.aefOtherTab);
  expect(cogRequests(log)).toEqual([]);
  await expect(p.locator("#aef-fetch")).toBeEnabled();
}

test("three tabs: the lock passes from tab to tab only as each holder closes", async ({ context }) => {
  const [a, b, c] = await pages(context, 3);
  await fetchChip(a!);
  await fetchedOk(a!);
  await fetchChip(b!);
  await expect(message(b!)).toHaveText(MESSAGES.aefOtherTab);
  await fetchChip(c!);
  await expect(message(c!)).toHaveText(MESSAGES.aefOtherTab);
  expect(await loaded(b!)).toBeNull();
  expect(await loaded(c!)).toBeNull();
  await a!.close();
  await b!.click("#aef-fetch"); // a refused fetch, retried once the holder is closed
  await fetchedOk(b!);
  await refused(c!);
  await b!.close();
  await c!.click("#aef-fetch");
  await fetchedOk(c!);
});

for (const how of ["closed", "reloaded"] as const) {
  test(`the holder ${how} mid-download: another tab can then fetch a whole, correct cache`, async ({ context }) => {
    const [a, b] = await pages(context, 2);
    const la = logRequests(a!);
    const gate = await holdCogs(a!);
    await fetchChip(a!);
    await expect(message(a!)).toHaveText("Downloading embeddings...");
    await expect.poll(() => cogRequests(la).length).toBeGreaterThan(0);
    await fetchChip(b!);
    await expect(message(b!)).toHaveText(MESSAGES.aefOtherTab);
    if (how === "closed") await a!.close();
    else { await a!.reload(); await openApp(a!); }
    gate.release();
    await b!.click("#aef-fetch");
    await fetchedOk(b!);
    if (how === "reloaded") {
      await fetchChip(a!);
      await expect(message(a!)).toHaveText(MESSAGES.aefOtherTab);
      expect((await chipMismatches(b!, REF)).mismatches, "tab B's data after A's refused fetch").toBe(0);
    }
  });
}

test("a re-fetch hands the lock to the new store: one lock request in all, held throughout, and another tab is refused mid-handover", async ({ context }) => {
  const [a, b] = await pages(context, 2);
  const removes = await holdRemoves(a!);
  await a!.reload(); // holdRemoves is an init script
  await openApp(a!);
  await fetchChip(a!);
  await fetchedOk(a!);
  expect(await lockRequests(a!)).toBe(1);
  await removes.hold();
  await a!.evaluate(() => { document.getElementById("message")!.textContent = "re-fetch started"; }); // so the first fetch's message can't pass for this one's
  await a!.click("#aef-fetch"); // the new store is inside opfsStore, deleting the old folder
  await expect.poll(() => removes.held()).toBeGreaterThan(0);
  expect(await lockHeld(b!), "the lock is held mid-handover").toBe(true);
  await fetchChip(b!);
  await expect(message(b!)).toHaveText(MESSAGES.aefOtherTab);
  await removes.release();
  await fetchedOk(a!);
  expect(await lockRequests(a!), "the re-fetch took over the lock instead of requesting it again").toBe(1);
  expect(await lockHeld(b!)).toBe(true);
  await refused(b!);
  expect((await chipMismatches(a!, REF)).mismatches).toBe(0);
});

test("a lock request that rejects shows its error and blocks nothing: another tab fetches, then this one retries once that tab closes", async ({ context }) => {
  const [a, b] = await pages(context, 2);
  const la = logRequests(a!);
  await a!.evaluate(() => { (window as any).__failLock = true; });
  await fetchChip(a!);
  await expect(message(a!)).toHaveText("locks refused");
  expect(cogRequests(la)).toEqual([]);
  expect(await loaded(a!)).toBeNull();
  await expect(a!.locator("#aef-fetch")).toBeEnabled();
  await expect(a!.locator("#open-aef")).toBeEnabled();
  await fetchChip(b!);
  await fetchedOk(b!);
  await refused(a!);
  await b!.close();
  await a!.click("#aef-fetch");
  await fetchedOk(a!);
});

test("an open that fails after taking the lock releases it: another tab fetches", async ({ context }) => {
  const [a, b] = await pages(context, 2);
  const la = logRequests(a!);
  await a!.evaluate(() => { (window as any).__failRoot = true; });
  await fetchChip(a!);
  await expect(message(a!)).toHaveText("no OPFS");
  expect(cogRequests(la)).toEqual([]);
  expect(await lockHeld(a!)).toBe(false);
  await fetchChip(b!);
  await fetchedOk(b!);
  await refused(a!);
});

test("a refused fetch over this tab's open file keeps the file and its lock-free state; a later fetch after the holder closes replaces it", async ({ context }) => {
  const [a, b] = await pages(context, 2);
  await fetchChip(a!);
  await fetchedOk(a!);
  await b!.setInputFiles("#open-aef", westFile());
  await expect(message(b!)).toHaveText("AlphaEarth file opened.");
  expect(await lockHeld(b!), "tab A still holds the lock").toBe(true);
  await fetchChip(b!);
  await expect(message(b!)).toHaveText(MESSAGES.aefOtherTab);
  expect((await loaded(b!))?.width).toBe(64);
  await a!.close();
  await b!.click("#aef-fetch");
  await fetchedOk(b!);
});

test("navigating the holder away releases the lock (it isn't kept by a cached page)", async ({ context }) => {
  const [a, b] = await pages(context, 2);
  await fetchChip(a!);
  await fetchedOk(a!);
  await a!.goto("about:blank");
  await fetchChip(b!);
  await fetchedOk(b!);
  await a!.goBack();
  await expect(a!.locator("#map[data-ready=true]")).toBeVisible();
  expect(await loaded(a!), "tab A came back without the cache, so it shows nothing loaded").toBeNull();
  await fetchChip(a!);
  await expect(message(a!)).toHaveText(MESSAGES.aefOtherTab);
  expect((await chipMismatches(b!, REF)).mismatches).toBe(0);
});

test("two browser contexts are two profiles: each has its own OPFS and locks, so both fetch", async ({ browser }) => {
  const c1 = await browser.newContext(), c2 = await browser.newContext();
  try {
    const [a] = await pages(c1, 1), [b] = await pages(c2, 1);
    await fetchChip(a!);
    await fetchedOk(a!);
    await fetchChip(b!);
    await fetchedOk(b!);
    expect((await chipMismatches(a!, REF)).mismatches).toBe(0);
  } finally {
    await c1.close(); await c2.close();
  }
});

test("two tabs clicking Fetch at the same moment: real Web Locks give the cache to exactly one", async ({ context }) => {
  const [a, b] = await pages(context, 2);
  for (const p of [a!, b!]) {
    await jumpTo(p, chipCentre, 15);
    await drawArea(p, lonLatBox(chip.epsg, chipBox, 30));
    await expect(p.locator("#aef-fetch")).toBeEnabled();
  }
  // both clicks dispatched in one Node tick, each in its own page
  await Promise.all([a!, b!].map((p) => p.evaluate(() => document.getElementById("aef-fetch")!.click())));
  const done = (p: Page) => expect(message(p)).toHaveText(/^(Embeddings downloaded\.|AlphaEarth embeddings are open in another tab\.)/);
  await done(a!); await done(b!);
  const texts = [await message(a!).textContent(), await message(b!).textContent()];
  expect(texts.filter((t) => t === "Embeddings downloaded.")).toHaveLength(1);
  expect(texts.filter((t) => t === MESSAGES.aefOtherTab)).toHaveLength(1);
  const winner = texts[0] === "Embeddings downloaded." ? a! : b!;
  expect((await chipMismatches(winner, REF)).mismatches).toBe(0);
  expect((await files64(winner)).ok).toBe(true);
});

// Tester F10: OPFS is per origin, so one tab at a time holds the AlphaEarth cache (a Web Locks lock). A second
// tab's fetch is refused with a message; nothing silently overwrites the first tab's cache.
test.describe("two tabs of the app share one OPFS origin (Scope: one set of AlphaEarth data)", () => {
  /** Draw a different area than tab A's in `b` (same window count, another grid) and click Fetch. */
  async function fetchOther(b: Page) {
    await openApp(b);
    await jumpTo(b, chipCentre, 13); // zoom 13 keeps the 200 m-margin box on screen
    await drawArea(b, lonLatBox(chip.epsg, chipBox, 200));
    await expect(b.locator("#aef-year option")).not.toHaveCount(0);
    await b.click("#aef-fetch");
  }

  /** Tab b was refused: the message, no COG request, nothing loaded, and both controls usable again. */
  async function refusedAt(b: Page, lb: Parameters<typeof cogRequests>[0]) {
    await expect(message(b)).toHaveText(MESSAGES.aefOtherTab);
    expect(cogRequests(lb), "tab B's COG requests").toEqual([]);
    expect(await b.evaluate(() => (window as any).__geoapp.aef())).toBeNull();
    await expect(b.locator("#aef-fetch")).toBeEnabled();
    await expect(b.locator("#open-aef")).toBeEnabled();
  }

  test("a fetch in a second tab is refused, and the first tab's loaded data stays readable and equal to the chip", async ({ context }) => {
    const a = await context.newPage(), b = await context.newPage();
    for (const p of [a, b]) await serveAef(p);
    const lb = logRequests(b);
    await openApp(a);
    await fetchChip(a);
    await expect(message(a)).toHaveText("Embeddings downloaded.");
    expect((await chipMismatches(a, REF)).mismatches).toBe(0);
    await fetchOther(b);
    await refusedAt(b, lb);
    const r = await chipMismatches(a, REF).catch((e: Error) => ({ mismatches: `threw: ${e.message}` }));
    expect(r.mismatches, "tab A's data after tab B's fetch").toBe(0);
    await chipLoaded(a);
  });

  test("two tabs fetching at once: the second is refused, and the first finishes with its own area", async ({ context }) => {
    const a = await context.newPage(), b = await context.newPage();
    for (const p of [a, b]) await serveAef(p);
    const la = logRequests(a), lb = logRequests(b);
    let answered = 0, open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    await a.route(`${AEF_BASE}**`, async (route) => { if (answered++ >= 100) await gate; await route.fallback(); });
    await openApp(a);
    await fetchChip(a);
    await expect.poll(() => cogRequests(la).length).toBeGreaterThan(100);
    await fetchOther(b);
    await refusedAt(b, lb);
    open();
    const text = await quiet(a, la);
    expect(text, "tab A's fetch").toBe("Embeddings downloaded.");
    expect((await chipMismatches(a, REF)).mismatches, "tab A's data must be the chip").toBe(0);
    await chipLoaded(a);
  });
});
