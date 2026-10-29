import { expect, test, type Page } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { MESSAGES } from "../../src/ui/messages";
import { chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, logRequests, lonLatBox, serveAef } from "./aef";
import { chipLoaded, chipMismatches, files64, quiet } from "./aefTester";
import { fetchedOk, pages, REF } from "./aefTabs";
import { jumpTo, message, openApp } from "./helpers";

// Tester re-verification of F10: two tabs fetching at once, and two browser contexts (two profiles) that don't share the cache.

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
