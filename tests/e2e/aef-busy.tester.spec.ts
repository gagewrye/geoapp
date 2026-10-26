import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { MESSAGES } from "../../src/ui/messages";
import { ATTRIBUTION, cacheFiles, chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, HOST, logRequests, lonLatBox, serveAef } from "./aef";
import { chipMismatches, files64, holdCogs, holdRemoves, quiet, westFile } from "./aefTester";
import { collectErrors, jumpTo, message, openApp } from "./helpers";

// Tester re-verification of F1-F4 and F7 (spec 002 Scope: one set of AlphaEarth data, one operation at a time):
// repeated clicks, keyboard activation, clicks while a previous cache unloads, file/fetch races, failures, reloads.
const REF = readFileSync("tests/fixtures/aef/ref_chip.i8");
const NOTE = /\(not fetched yet; the loaded data is another area\)$/;
const fetchBtn = (page: Page) => page.locator("#aef-fetch");
const openBtn = (page: Page) => page.locator("#open-aef");
const loadedWidth = (page: Page) => page.evaluate(() => (window as any).__geoapp.aef()?.aoi.width ?? null);
const asked = (log: Parameters<typeof cogRequests>[0]) => cogRequests(log).map((r) => `${r.url()} ${r.headers().range ?? ""}`);

/** In one task, set the west file on the AlphaEarth input and dispatch its change, then (or first) click Fetch. */
function race(page: Page, fileFirst: boolean) {
  return page.evaluate(([b64, first]) => {
    const input = document.getElementById("open-aef") as HTMLInputElement;
    const btn = document.getElementById("aef-fetch") as HTMLButtonElement;
    const openIt = () => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "west.tiff", { type: "image/tiff" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // dispatchEvent, not click(): it reaches the listener even if the button is already disabled
    const clickIt = () => btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    if (first) { openIt(); clickIt(); } else { clickIt(); openIt(); }
    return input.value;
  }, [westFile().buffer.toString("base64"), fileFirst] as const);
}

/** One complete fetch over the chip; returns how many COG requests it made. */
async function oneFetch(page: Page, log: Parameters<typeof cogRequests>[0]): Promise<number> {
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  return cogRequests(log).length;
}

/** The loaded data is the chip, cached as 64 good band files, with the preview and attribution shown. */
async function chipLoaded(page: Page) {
  const f = await files64(page);
  expect(f.ok, JSON.stringify(f)).toBe(true);
  expect((await chipMismatches(page, REF)).mismatches).toBe(0);
  await expect(page.locator("#aef-preview")).toBeChecked();
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();
}

test.describe("repeated activation of Fetch (F1)", () => {
  test("a triple-clicked first Fetch runs one download, each COG range once, and leaves the chip loaded", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    const single = await oneFetch(page, log);
    // a fresh page for the real case: the first Fetch of a session
    await page.reload();
    log.length = 0;
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    await page.click("#aef-fetch", { clickCount: 3 });
    const text = await quiet(page, log);
    expect(errors).toEqual([]);
    expect(text).toBe("Embeddings downloaded.");
    expect(cogRequests(log).length, "COG requests of a triple click").toBe(single);
    expect(new Set(asked(log)).size).toBe(single);
    await chipLoaded(page);
  });

  test("Enter and Space on a focused Fetch: the first starts one download, the rest do nothing until it ends", async ({ page }) => {
    await serveAef(page);
    const log = logRequests(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    await fetchBtn(page).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press(" ");
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await expect(fetchBtn(page)).toBeDisabled();
    await expect(openBtn(page)).toBeDisabled();
    gate.release();
    const text = await quiet(page, log);
    expect(text).toBe("Embeddings downloaded.");
    const a = asked(log);
    expect(new Set(a).size, "each COG range requested once").toBe(a.length);
    await chipLoaded(page);
  });

  test("Space alone on a focused Fetch fetches (keyboard users can fetch)", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await fetchBtn(page).focus();
    await page.keyboard.press(" ");
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    await chipLoaded(page);
  });
});

test.describe("acting while the previous cache is being unloaded (F1)", () => {
  test("clicks, keys and a file set while the old cache's delete is held start nothing; one download follows", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    const rm = await holdRemoves(page);
    const log = logRequests(page);
    await openApp(page);
    const single = await oneFetch(page, log);
    await rm.hold();
    await page.click("#aef-fetch");
    await expect.poll(() => rm.held(), { message: "the unload's delete is held" }).toBeGreaterThan(0);
    // still unloading: no download has started yet
    expect(cogRequests(log).length).toBe(single);
    await expect(fetchBtn(page)).toBeDisabled();
    await expect(openBtn(page)).toBeDisabled();
    await page.click("#aef-fetch", { force: true, clickCount: 2 });
    await fetchBtn(page).dispatchEvent("click");
    await page.keyboard.press("Enter");
    await page.setInputFiles("#open-aef", westFile());
    await expect(openBtn(page), "an ignored file is cleared from the input").toHaveValue("");
    await rm.release();
    const text = await quiet(page, log);
    expect(errors).toEqual([]);
    expect(text).toBe("Embeddings downloaded.");
    expect(cogRequests(log).length - single, "COG requests after the first fetch").toBe(single);
    expect(await loadedWidth(page)).not.toBe(64);
    await chipLoaded(page);
  });

  test("a file opened over fetched data while the old cache's delete is held: Fetch can't start, the file ends loaded, no cache left", async ({ page }) => {
    await serveAef(page);
    const rm = await holdRemoves(page);
    const log = logRequests(page);
    await openApp(page);
    const single = await oneFetch(page, log);
    await rm.hold();
    await page.setInputFiles("#open-aef", westFile());
    await expect.poll(() => rm.held()).toBeGreaterThan(0);
    await expect(fetchBtn(page)).toBeDisabled();
    await fetchBtn(page).dispatchEvent("click");
    await rm.release();
    const text = await quiet(page, log);
    expect(text).toBe("AlphaEarth file opened.");
    expect(cogRequests(log).length).toBe(single);
    expect(await loadedWidth(page)).toBe(64);
    expect(await cacheFiles(page)).toBeNull();
    await expect(page.getByText(ATTRIBUTION)).toBeVisible();
    await expect(fetchBtn(page)).toBeEnabled();
  });
});

test.describe("file open and Fetch in the same task (F1, F2)", () => {
  test("file change then Fetch click: the file opens, nothing is fetched", async ({ page }) => {
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    await race(page, true);
    const text = await quiet(page, log);
    expect(text).toBe("AlphaEarth file opened.");
    expect(cogRequests(log)).toEqual([]);
    expect(await loadedWidth(page)).toBe(64);
    expect(await cacheFiles(page)).toBeNull();
    await expect(page.locator("#aef-info")).toHaveText(NOTE); // F7: the drawn area isn't the file's grid
  });

  test("Fetch click then file change: the change is ignored and cleared, the chip is fetched", async ({ page }) => {
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(fetchBtn(page)).toBeEnabled();
    const value = await race(page, false);
    expect(value, "the ignored file is cleared from the input").toBe("");
    const text = await quiet(page, log);
    expect(text).toBe("Embeddings downloaded.");
    expect(await loadedWidth(page)).not.toBe(64);
    await chipLoaded(page);
  });

  test("two file changes in one task: the first opens, the second is ignored", async ({ page }) => {
    await openApp(page);
    await page.evaluate(([b64]) => {
      const input = document.getElementById("open-aef") as HTMLInputElement;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      for (const name of ["west.tiff", "junk.tiff"]) {
        const dt = new DataTransfer();
        dt.items.add(new File([name === "west.tiff" ? bytes : new Uint8Array(10)], name, { type: "image/tiff" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, [westFile().buffer.toString("base64")] as const);
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    expect(await loadedWidth(page)).toBe(64);
  });
});

test.describe("failures around a file and a fetch (F1, F8 accepted under criterion 12)", () => {
  test("a fetch that fails while a file is loaded: the message, nothing loaded, and the file can be opened again", async ({ page }) => {
    await serveAef(page, () => 500);
    const log = logRequests(page);
    await openApp(page);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    await jumpTo(page, chipCentre, 15);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(page.locator("#aef-info")).toHaveText(NOTE);
    await page.click("#aef-fetch");
    await expect(message(page)).toHaveText(`Couldn't download embeddings from ${HOST}.`);
    expect(await loadedWidth(page)).toBeNull();
    expect(await cacheFiles(page)).toBeNull();
    await expect(page.getByText(ATTRIBUTION)).toBeHidden();
    await expect(page.locator("#train")).toBeDisabled();
    await expect(page.locator("#aef-info")).not.toHaveText(NOTE); // nothing is loaded now
    await expect(fetchBtn(page)).toBeEnabled();
    await expect(openBtn(page)).toBeEnabled();
    await page.setInputFiles("#open-aef", []);
    await page.setInputFiles("#open-aef", westFile());
    await expect(message(page)).toHaveText("AlphaEarth file opened.");
    expect(await loadedWidth(page)).toBe(64);
    void log;
  });

  test("a file set during a fetch that then fails is not opened afterwards", async ({ page }) => {
    let fail = false;
    await serveAef(page, () => (fail ? "network" : undefined));
    const log = logRequests(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await page.setInputFiles("#open-aef", westFile());
    fail = true;
    gate.release();
    const text = await quiet(page, log);
    expect(text).toBe(`Couldn't download embeddings from ${HOST}.`);
    expect(await loadedWidth(page)).toBeNull();
    expect(await cacheFiles(page)).toBeNull();
    await expect(openBtn(page)).toHaveValue("");
    await expect(openBtn(page)).toBeEnabled();
    await expect(fetchBtn(page)).toBeEnabled();
  });

  test("a refused file while fetched data is loaded keeps that data, its cache, attribution and Fetch", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    await page.setInputFiles("#open-aef", { name: "x.tiff", mimeType: "image/tiff", buffer: Buffer.alloc(16) });
    await expect(message(page)).not.toHaveText("Embeddings downloaded.");
    await expect(message(page)).not.toHaveText("");
    await chipLoaded(page);
    await expect(fetchBtn(page)).toBeEnabled();
    await expect(page.locator("#train")).toBeDisabled();
  });
});

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

test.describe("index (F4)", () => {
  for (const [what, answer] of [["is unreachable", "abort"], ["is not JSON", "{not json"], ["is not a list of years", '{"years":[2021]}']] as const) {
    test(`years.json ${what}: the index message, and Fetch stays disabled`, async ({ page }) => {
      await serveAef(page);
      await page.route("**/aef-index/years.json", (r) => (answer === "abort" ? r.abort("failed") : r.fulfill({ status: 200, contentType: "application/json", body: answer })));
      await openApp(page);
      await expect(message(page)).toHaveText(MESSAGES.aefIndex);
      await jumpTo(page, chipCentre, 13);
      await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
      await expect(page.locator("#aef-info")).toHaveText(/^Area: /);
      await expect(fetchBtn(page)).toBeDisabled();
    });
  }

  test("years.json arriving after the area is drawn enables Fetch, with no index message", async ({ page }) => {
    await serveAef(page);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    await page.route("**/aef-index/years.json", async (r) => { await gate; await r.fallback(); });
    await openApp(page);
    await jumpTo(page, chipCentre, 13);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
    await expect(page.locator("#aef-info")).toHaveText(/^Area: /);
    await expect(fetchBtn(page)).toBeDisabled();
    open();
    await expect(fetchBtn(page)).toBeEnabled();
    await expect(message(page)).not.toHaveText(MESSAGES.aefIndex);
  });
});

// FOLLOW-UP (tester F10): the one-store-per-folder guard is per page, but OPFS is per origin, so a second tab's
// fetch rewrites the first tab's "aef-cache" folder. Marked as expected failures so a fix shows up as a pass to update.
test.describe("two tabs of the app share one OPFS origin (Scope: one set of AlphaEarth data)", () => {
  test("a fetch in a second tab leaves the first tab's loaded data readable and correct", async ({ context }) => {
    test.fail();
    const a = await context.newPage(), b = await context.newPage();
    for (const p of [a, b]) await serveAef(p);
    await openApp(a);
    await fetchChip(a);
    await expect(message(a)).toHaveText("Embeddings downloaded.");
    expect((await chipMismatches(a, REF)).mismatches).toBe(0);
    await openApp(b);
    // a different area: same window count, so the band files keep their size but hold another grid
    await jumpTo(b, chipCentre, 13); // zoom 13 keeps the 200 m-margin box on screen
    await drawArea(b, lonLatBox(chip.epsg, chipBox, 200));
    await expect(b.locator("#aef-year option")).not.toHaveCount(0);
    await b.click("#aef-fetch");
    await expect(message(b)).toHaveText("Embeddings downloaded.");
    const r = await chipMismatches(a, REF).catch((e: Error) => ({ mismatches: `threw: ${e.message}` }));
    expect(r.mismatches, "tab A's data after tab B fetched").toBe(0);
  });

  test("two tabs fetching at once: the first tab's data is its own area, or its fetch fails with a message", async ({ context }) => {
    test.fail();
    const a = await context.newPage(), b = await context.newPage();
    for (const p of [a, b]) await serveAef(p);
    const la = logRequests(a), lb = logRequests(b);
    let answered = 0, open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    await a.route(`${AEF_BASE}**`, async (route) => { if (answered++ >= 100) await gate; await route.fallback(); });
    await openApp(a);
    await fetchChip(a);
    await expect.poll(() => cogRequests(la).length).toBeGreaterThan(100);
    await openApp(b);
    await jumpTo(b, chipCentre, 13);
    await drawArea(b, lonLatBox(chip.epsg, chipBox, 200));
    await expect(b.locator("#aef-year option")).not.toHaveCount(0);
    await b.click("#aef-fetch");
    await quiet(b, lb);
    open();
    const text = await quiet(a, la);
    if (text === "Embeddings downloaded.") expect((await chipMismatches(a, REF)).mismatches, "tab A reports success: its data must be the chip").toBe(0);
    else expect(await a.evaluate(() => (window as any).__geoapp.aef())).toBeNull();
  });
});
