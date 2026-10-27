import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { ATTRIBUTION, chip, chipBox, chipCentre, cogRequests, drawArea, fetchChip, logRequests, lonLatBox, serveAef } from "./aef";
import { chipMismatches, files64, holdCogs, quiet, serveYears } from "./aefTester";
import { collectErrors, jumpTo, message, openApp } from "./helpers";

// Tester e2e for spec 002's year picker, years.json and Fetch states (criteria 11, 13; tester F1, F4, F11).
const REF = readFileSync("tests/fixtures/aef/ref_chip.i8");
const rectIds = (page: Page) => page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().filter((f: any) => f.properties.mode === "rectangle").map((f: any) => f.id));
const box = lonLatBox(chip.epsg, chipBox, 30);
const fetchBtn = (page: Page) => page.locator("#aef-fetch");

test.describe("year picker and Fetch states (criteria 11, 13)", () => {
  test("years come from years.json with the latest selected; a year without a shard says there's nothing, with no COG request", async ({ page }) => {
    await serveAef(page);
    await serveYears(page, [2019, 2020, 2021]);
    const log = logRequests(page);
    await openApp(page);
    await expect(page.locator("#aef-fetch")).toBeDisabled(); // no area yet
    await expect(page.locator("#aef-year option")).toHaveText(["2019", "2020", "2021"]);
    await expect(page.locator("#aef-year")).toHaveValue("2021");
    await fetchChip(page, "2019");
    await expect(message(page)).toHaveText("No AlphaEarth embeddings here for 2019.");
    expect(cogRequests(log)).toEqual([]);
    await expect(page.getByText(ATTRIBUTION)).toBeHidden();
    await expect(page.locator("#aef-fetch")).toBeEnabled(); // can try another year
  });

  // Tester F4: the message says why Fetch stays disabled, at load and again once an area is drawn.
  for (const [what, answer] of [["fails to load", { status: 500, body: "x" }], ["lists no years", { status: 200, contentType: "application/json", body: "[]" }]] as const) {
    test(`when years.json ${what}, a message says so and Fetch stays disabled`, async ({ page }) => {
      await serveAef(page);
      await page.route("**/aef-index/years.json", (r) => r.fulfill(answer));
      await openApp(page);
      await expect(message(page)).toHaveText(MESSAGES.aefIndex);
      await jumpTo(page, chipCentre, 13);
      await drawArea(page, box);
      await expect(page.locator("#aef-info")).not.toHaveText("");
      await expect(page.locator("#aef-fetch")).toBeDisabled();
      await expect(message(page)).toHaveText(MESSAGES.aefIndex);
    });
  }

  test("mid-fetch, changing the year or redrawing the area keeps Fetch disabled, and the fetch finishes for the original area and year", async ({ page }) => {
    await serveAef(page);
    await serveYears(page, [2020, 2021]);
    const log = logRequests(page);
    const gate = await holdCogs(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Downloading embeddings...");
    await expect(page.locator("#aef-fetch")).toBeDisabled();
    await expect(page.locator("#train")).toBeDisabled();
    await page.selectOption("#aef-year", "2020");
    await expect(page.locator("#aef-fetch")).toBeDisabled();
    // F11: the fetch is for 2021, so the info line says so; the area part is the fetched area's
    await expect(page.locator("#aef-info")).toHaveText(/ \(not fetched yet; the loaded data is for 2021\)$/);
    const fetchedInfo = (await page.locator("#aef-info").textContent())!.replace(/ \(not fetched yet; the loaded data is for 2021\)$/, "");
    const fetchedIds = await rectIds(page);
    // zoom 13 keeps the 200 m-margin box on screen, so the redraw registers (at zoom 15 it ran off the map)
    await jumpTo(page, chipCentre, 13);
    await drawArea(page, lonLatBox(chip.epsg, chipBox, 200));
    const NOTE = " (not fetched yet; the loaded data is another area)";
    await expect(page.locator("#aef-info"), "the redraw replaced the area (F7 note)").toHaveText(/^Area: \d+ x \d+ px, EPSG:32617 \(not fetched yet; the loaded data is another area\)$/);
    expect(await rectIds(page), "one rectangle, the new one").toHaveLength(1);
    expect(await rectIds(page)).not.toEqual(fetchedIds);
    expect(await page.locator("#aef-info").textContent()).not.toBe(fetchedInfo + NOTE);
    await expect(page.locator("#aef-fetch")).toBeDisabled();
    gate.release();
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    expect(cogRequests(log).every((r) => r.url().includes("/2021/"))).toBe(true);
    const r = await chipMismatches(page, REF);
    expect(r.mismatches).toBe(0);
    expect(r.outsideNaN).toBe(true);
    // the loaded data is the area fetched, not the one redrawn: its size is the one shown before the redraw
    const loaded = await page.evaluate(() => (window as any).__geoapp.aef().aoi);
    expect(`Area: ${loaded.width} x ${loaded.height} px, EPSG:${loaded.epsg}`).toBe(fetchedInfo);
    await expect(page.locator("#aef-info")).toHaveText(/\(not fetched yet; the loaded data is another area\)$/);
    await expect(page.locator("#aef-fetch")).toBeEnabled();
    await expect(page.locator("#aef-year")).toHaveValue("2020"); // the next Fetch is for the redrawn area and 2020
  });

  test("fetching twice in a row: one cache of 64 band files, tiles equal the chip, preview and attribution shown", async ({ page }) => {
    await serveAef(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    await page.locator("#aef-preview").uncheck();
    await page.click("#aef-fetch");
    await expect(message(page)).toHaveText("Downloading embeddings..."); // shown only after the old data is unloaded
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    expect((await files64(page)).ok).toBe(true);
    expect((await chipMismatches(page, REF)).mismatches).toBe(0);
    await expect(page.locator("#aef-preview")).toBeChecked();
    await expect(page.getByText(ATTRIBUTION)).toBeVisible();
  });

  // BLOCKING (tester F1): the busy state is set only after the old cache is discarded, so the second click starts a
  // second download into the same OPFS folder. In the fixture both write the same bytes and the cache ends right.
  test("a double click on Fetch after an earlier fetch runs one download, leaving one good cache", async ({ page }) => {
    const errors = collectErrors(page);
    await serveAef(page);
    const log = logRequests(page);
    await openApp(page);
    await fetchChip(page);
    await expect(message(page)).toHaveText("Embeddings downloaded.");
    const before = cogRequests(log).length;
    await page.dblclick("#aef-fetch");
    const text = await quiet(page, log);
    expect(errors).toEqual([]);
    expect(text).toBe("Embeddings downloaded.");
    expect((await files64(page)).ok).toBe(true);
    expect((await chipMismatches(page, REF)).mismatches).toBe(0);
    expect(cogRequests(log).length - before, "COG requests of the second click").toBe(before);
  });
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
