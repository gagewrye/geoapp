import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { cogRequests, fetchChip, logRequests } from "./aef";
import { chipMismatches, holdRemoves, lockHeld, lockReleased } from "./aefTester";
import { fetchedOk, loaded, lockRequests, pages, REF, refused } from "./aefTabs";
import { message, openApp } from "./helpers";

// Tester re-verification of F10, the lock itself: a re-fetch hands it over, and a lock request or open that fails blocks nothing.

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
  await lockReleased(a!);
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
