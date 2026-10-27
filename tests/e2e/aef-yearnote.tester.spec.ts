import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { AEF_BASE } from "../../src/core/aef";
import { chip, chipBox, chipCentre, drawArea, fetchChip, lonLatBox, serveAef } from "./aef";
import { chipMismatches, serveYears, westFile } from "./aefTester";
import { jumpTo, message, openApp } from "./helpers";
import { aefTiff, pattern } from "../unit/helpers/aefTiff";

// Tester re-verification of F11: the info line's year note, its precedence under the area note,
// files (no year) and fetches, and year or area changes during a fetch.
const REF = readFileSync("tests/fixtures/aef/ref_chip.i8");
const AREA = /^Area: \d+ x \d+ px, EPSG:32617$/;
const OTHER_AREA = /^Area: \d+ x \d+ px, EPSG:32617 \(not fetched yet; the loaded data is another area\)$/;
const forYear = (y: number) => new RegExp(`^Area: \\d+ x \\d+ px, EPSG:32617 \\(not fetched yet; the loaded data is for ${y}\\)$`);
const info = (p: Page) => p.locator("#aef-info");
const otherBox = lonLatBox(chip.epsg, chipBox, 200);

/** Redraw the box fetchChip draws, from the same view, so the area is the same grid. */
async function redrawChipArea(p: Page): Promise<void> {
  await jumpTo(p, chipCentre, 15);
  await drawArea(p, lonLatBox(chip.epsg, chipBox, 30));
}
async function drawOther(p: Page): Promise<void> {
  await jumpTo(p, chipCentre, 13);
  await drawArea(p, otherBox);
}

/** Hold COG answers only while held; unlike holdCogs, it can be armed after a first fetch. */
async function holdable(p: Page) {
  let gate: Promise<void> | undefined, open = () => {};
  await p.route(`${AEF_BASE}**`, async (r) => { if (gate) await gate; await r.fallback(); });
  return {
    hold: () => { gate = new Promise<void>((r) => { open = r; }); },
    release: () => { gate = undefined; open(); },
  };
}

/** The fixture COGs listed for 2020 too, so a 2020 fetch downloads the same chip. */
async function serve2020(p: Page): Promise<void> {
  const shard = (JSON.parse(readFileSync("tests/fixtures/aef/aef-index/2021/32617.json", "utf8")) as { year: number }[]).map((e) => ({ ...e, year: 2020 }));
  await p.route("**/aef-index/2020/32617.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(shard) }));
}

async function setup(p: Page) {
  await serveAef(p);
  await serveYears(p, [2020, 2021]);
  await serve2020(p);
  const h = await holdable(p);
  await openApp(p);
  return h;
}

test("precedence: another area wins over another year, and returning to the loaded area brings the year note back", async ({ page }) => {
  await setup(page);
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(info(page)).toHaveText(AREA);
  const fetchedInfo = await info(page).textContent();
  await page.selectOption("#aef-year", "2020");
  await expect(info(page)).toHaveText(forYear(2021));
  await drawOther(page);
  await expect(info(page), "area and year both differ: only the area note").toHaveText(OTHER_AREA);
  await page.selectOption("#aef-year", "2021");
  await expect(info(page)).toHaveText(OTHER_AREA);
  await page.selectOption("#aef-year", "2020");
  await redrawChipArea(page);
  await expect(info(page), "the loaded area again, another year").toHaveText(forYear(2021));
  await page.selectOption("#aef-year", "2021");
  await expect(info(page)).toHaveText(fetchedInfo!);
});

test("a file, then a fetch: the file has no year, so only the area counts; the fetched data has one", async ({ page }) => {
  await setup(page);
  await page.setInputFiles("#open-aef", westFile());
  await expect(message(page)).toHaveText("AlphaEarth file opened.");
  await jumpTo(page, chipCentre, 15);
  await drawArea(page, lonLatBox(chip.epsg, chipBox, 30));
  await expect(page.locator("#aef-year option")).not.toHaveCount(0);
  await expect(info(page)).toHaveText(OTHER_AREA);
  await page.selectOption("#aef-year", "2020");
  await expect(info(page), "no year note for a file").toHaveText(OTHER_AREA);
  await page.selectOption("#aef-year", "2021");
  await page.click("#aef-fetch");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(info(page)).toHaveText(AREA);
  await page.selectOption("#aef-year", "2020");
  await expect(info(page)).toHaveText(forYear(2021));
});

test("a file on exactly the drawn area's grid: no note for any year", async ({ page }) => {
  await setup(page);
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  const aoi = await page.evaluate(() => (window as any).__geoapp.aef().aoi);
  const buffer = Buffer.from(aefTiff({ width: aoi.width, height: aoi.height, x0: aoi.gt[0], y1: aoi.gt[3], value: (b, r, c) => pattern(b, c, r), deflate: true }));
  await page.setInputFiles("#open-aef", { name: "same-grid.tiff", mimeType: "image/tiff", buffer });
  await expect(message(page)).toHaveText("AlphaEarth file opened.");
  expect(await page.evaluate(() => (window as any).__geoapp.aef().aoi)).toEqual(aoi);
  for (const y of ["2020", "2021", "2020"]) {
    await page.selectOption("#aef-year", y);
    await expect(info(page), `year ${y}`).toHaveText(AREA);
  }
});

test("a re-fetch for another year: while it runs, the note follows the year being fetched, not the unloaded data", async ({ page }) => {
  const h = await setup(page);
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await page.selectOption("#aef-year", "2020");
  await expect(info(page)).toHaveText(forYear(2021));
  h.hold();
  await page.click("#aef-fetch");
  await expect(message(page)).toHaveText("Downloading embeddings...");
  expect(await page.evaluate(() => (window as any).__geoapp.aef()), "the 2021 data is unloaded").toBeNull();
  await expect(info(page), "the running fetch is for the selected year, 2020").toHaveText(AREA);
  await page.selectOption("#aef-year", "2021");
  await expect(info(page)).toHaveText(forYear(2020));
  await page.selectOption("#aef-year", "2020");
  await expect(info(page)).toHaveText(AREA);
  h.release();
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(info(page)).toHaveText(AREA);
  await page.selectOption("#aef-year", "2021");
  await expect(info(page)).toHaveText(forYear(2020));
});

test("a re-fetch for a newly drawn area: while it runs, the info line doesn't say the loaded data is another area", async ({ page }) => {
  const h = await setup(page);
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await drawOther(page);
  await expect(info(page)).toHaveText(OTHER_AREA);
  h.hold();
  await page.click("#aef-fetch");
  await expect(message(page)).toHaveText("Downloading embeddings...");
  expect(await page.evaluate(() => (window as any).__geoapp.aef()), "the earlier data is unloaded").toBeNull();
  await expect(info(page), "the running fetch is for this area").toHaveText(AREA);
  h.release();
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(info(page)).toHaveText(AREA);
});

test("year changes during a first fetch: the note comes and goes, and the fetch is for the year it started with", async ({ page }) => {
  const h = await setup(page);
  h.hold();
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Downloading embeddings...");
  for (const [y, want] of [["2020", forYear(2021)], ["2021", AREA], ["2020", forYear(2021)]] as const) {
    await page.selectOption("#aef-year", y);
    await expect(info(page), `year ${y} mid-fetch`).toHaveText(want);
  }
  h.release();
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(info(page)).toHaveText(forYear(2021));
  expect((await chipMismatches(page, REF)).mismatches).toBe(0);
});

test("after a failed re-fetch nothing is loaded, so no note for any year", async ({ page }) => {
  let fail = false;
  await serveAef(page, () => (fail ? 500 : undefined));
  await serveYears(page, [2020, 2021]);
  await serve2020(page);
  await openApp(page);
  await fetchChip(page, "2021");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await page.selectOption("#aef-year", "2020");
  fail = true;
  await page.click("#aef-fetch");
  await expect(message(page)).toHaveText(/^Couldn't download embeddings from /);
  for (const y of ["2020", "2021"]) {
    await page.selectOption("#aef-year", y);
    await expect(info(page)).toHaveText(AREA);
  }
});
