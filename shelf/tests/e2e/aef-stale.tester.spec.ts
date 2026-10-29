import { expect, test } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { cacheFiles, cogRequests, fetchChip, logRequests, serveAef } from "./aef";
import { chipLoaded } from "./aefTester";
import { collectErrors, message, openApp } from "./helpers";

// Tester re-verification of F1: an aef-cache folder left by an earlier page load (a reload mid-fetch, a crash)
// doesn't spoil the next session's fetch.
test.describe("page reload mid-fetch (stale aef-cache folder from an earlier page load)", () => {
  for (const after of [0, 100]) {
    test(`reload with the download held after ${after} COG answers: the next session fetches cleanly`, async ({ page }) => {
      const errors = collectErrors(page);
      await serveAef(page);
      let holding = true, answered = 0, open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      await page.route(`${AEF_BASE}**`, async (route) => {
        if (holding && answered++ >= after) await gate;
        await route.fallback().catch(() => {}); // the request may belong to the unloaded page
      });
      const log = logRequests(page);
      await openApp(page);
      await fetchChip(page);
      await expect(message(page)).toHaveText("Downloading embeddings...");
      await expect.poll(() => cogRequests(log).length).toBeGreaterThan(after);
      await page.reload();
      holding = false;
      open();
      await openApp(page);
      const stale = await cacheFiles(page);
      test.info().annotations.push({ type: "stale folder after reload", description: JSON.stringify(stale && Object.keys(stale).length) });
      await fetchChip(page);
      await expect(message(page)).toHaveText("Embeddings downloaded.");
      expect(errors).toEqual([]);
      await chipLoaded(page);
    });
  }
});

test("a leftover aef-cache folder from a crashed session (junk, wrong sizes, a subfolder) is replaced by a clean cache", async ({ page }) => {
  const errors = collectErrors(page);
  await serveAef(page);
  await openApp(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("aef-cache", { create: true });
    for (const [name, size] of [["b0.i8", 3 * 65536 + 7], ["b63.i8", 1], ["b64.i8", 65536], ["junk.crswap", 10]] as const) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(new Uint8Array(size).fill(1));
      await w.close();
    }
    await (await dir.getDirectoryHandle("sub", { create: true })).getFileHandle("x", { create: true });
  });
  await page.reload();
  await openApp(page);
  expect(Object.keys((await cacheFiles(page).catch(() => ({ sub: 0 }))) ?? {}).length, "the leftover folder is there at start").toBeGreaterThan(0);
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  expect(errors).toEqual([]);
  await chipLoaded(page);
});
