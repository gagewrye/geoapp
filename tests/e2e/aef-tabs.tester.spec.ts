import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { cogRequests, fetchChip, logRequests } from "./aef";
import { chipMismatches, holdCogs, lockHeld, lockReleased, westFile } from "./aefTester";
import { fetchedOk, loaded, pages, REF, refused } from "./aefTabs";
import { message, openApp } from "./helpers";

// Tester re-verification of F10: try to get two tabs onto the AlphaEarth cache at once.
// Web Locks and OPFS are per origin per browser profile. In Playwright a BrowserContext is its own profile,
// so "tabs" here are pages of one context; aef-tabs-race.tester.spec.ts shows two contexts don't share the lock (or OPFS).
// This file: the lock passes on only as its holder closes, reloads or navigates away.

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
  await lockReleased(b!);
  await b!.click("#aef-fetch"); // a refused fetch, retried once the holder is closed
  await fetchedOk(b!);
  await refused(c!);
  await b!.close();
  await lockReleased(c!);
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
    await lockReleased(b!);
    await b!.click("#aef-fetch");
    await fetchedOk(b!);
    if (how === "reloaded") {
      await fetchChip(a!);
      await expect(message(a!)).toHaveText(MESSAGES.aefOtherTab);
      expect((await chipMismatches(b!, REF)).mismatches, "tab B's data after A's refused fetch").toBe(0);
    }
  });
}

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
  await lockReleased(b!);
  await b!.click("#aef-fetch");
  await fetchedOk(b!);
});

test("navigating the holder away releases the lock (it isn't kept by a cached page)", async ({ context }) => {
  const [a, b] = await pages(context, 2);
  await fetchChip(a!);
  await fetchedOk(a!);
  await a!.goto("about:blank");
  await lockReleased(b!);
  await fetchChip(b!);
  await fetchedOk(b!);
  await a!.goBack();
  await expect(a!.locator("#map[data-ready=true]")).toBeVisible();
  expect(await loaded(a!), "tab A came back without the cache, so it shows nothing loaded").toBeNull();
  await fetchChip(a!);
  await expect(message(a!)).toHaveText(MESSAGES.aefOtherTab);
  expect((await chipMismatches(b!, REF)).mismatches).toBe(0);
});
