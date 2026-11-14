import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { once, RGB_GRID, rgbFixture } from "./fixtures";
import { jumpTo, message, openApp, openRaster, paintMode, path, selectClass, stroke, toScreen } from "./helpers";
import { at, effectiveTiles, importFile, maskFile, saved, tileDiff, upload } from "./seeding";
import { writeFile } from "../unit/helpers/labelFiles";

// Spec 075 criterion 7: an import keeps the labels it replaces, and the restore prompt offers them back.

/** A second mask on rgbFixture's grid, its 16 px blocks shifted by one class from maskFile's; built once per worker (spec 072). */
const maskB = once(() => upload("mask-b.tif", writeFile(RGB_GRID, 1, (() => {
  const v = new Uint8Array(1000 * 1000);
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 1000; c++) v[r * 1000 + c] = ((c >> 4) + (r >> 4) + 1) % 4;
  return v;
})(), "0", { GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 })));

/** Answers dialogs in order (true accepts, false dismisses) and logs their messages; beforeunload is accepted. */
function answer(page: Page) {
  const queue: boolean[] = [], log: string[] = [];
  page.on("dialog", (d) => {
    log.push(d.message());
    if (d.type() === "beforeunload" || queue.shift()) void d.accept(); else void d.dismiss();
  });
  return { log, then: (...a: boolean[]) => { queue.push(...a); } };
}

async function paintAt(page: Page, c: number, r: number) {
  await jumpTo(page, at(c, r), 10);
  await selectClass(page, 1);
  await stroke(page, path(await toScreen(page, at(c - 10, r)), await toScreen(page, at(c + 10, r + 5)), 6));
}

/** The stored sessions' roles, by mask pixel count (the record's base.count). */
const roles = (page: Page) => page.evaluate(() => new Promise<Record<string, number>>((resolve) => {
  const open = indexedDB.open("geoplatform");
  open.onsuccess = () => {
    const r = open.result.transaction("sessions").objectStore("sessions").getAll();
    r.onsuccess = () => resolve(Object.fromEntries((r.result as { role: string; base: { count: number } }[]).map((s) => [s.role, s.base.count])));
  };
}));

async function reopen(page: Page) {
  await page.reload();
  await expect(page.locator("#map[data-ready=true]")).toBeVisible();
  await openRaster(page, rgbFixture());
}

/** Imports mask A and paints, then mask B (OK on Replace labels?) and paints, then waits for Saved; A's tiles and the role counts. */
async function importAThenB(page: Page, dialogs: ReturnType<typeof answer>) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(/^Seeded /);
  await paintMode(page);
  await paintAt(page, 400, 400);
  const a = await effectiveTiles(page);
  dialogs.then(true); // Replace labels? Then the import saves A's last changes as A's, before it replaces them (spec 075)
  await importFile(page, maskB());
  await expect(message(page)).toHaveText(/^Seeded /);
  await paintMode(page);
  await paintAt(page, 600, 300);
  await saved(page);
  const b = await effectiveTiles(page);
  expect(tileDiff(a, b).length).toBeGreaterThan(0);
  const counts = await roles(page);
  expect(Object.keys(counts).sort()).toEqual(["current", "replaced"]);
  return { a, counts };
}

test("import A, paint, import B, paint; reopening, Cancel then OK on '…instead?' shows A, with B kept as replaced", async ({ page }) => {
  const dialogs = answer(page);
  const { a, counts } = await importAThenB(page, dialogs);
  dialogs.then(false, true); // Cancel the restore, then OK "…instead?"
  await reopen(page);
  await expect(message(page)).toHaveText("Labels restored.");
  expect(dialogs.log.at(-1)).toMatch(/^Restore the labels replaced on .+ instead\? The newer labels are kept\.$/);
  expect(tileDiff(await effectiveTiles(page), a)).toEqual([]);
  expect(await roles(page)).toEqual({ current: counts.replaced, replaced: counts.current });
});

test("after the '…instead?' swap, a reload, open and accept restores A again, with B still stored as replaced", async ({ page }) => {
  const dialogs = answer(page);
  const { a, counts } = await importAThenB(page, dialogs);
  dialogs.then(false, true); // the swap: Cancel the restore, then OK "…instead?"
  await reopen(page);
  await expect(message(page)).toHaveText("Labels restored.");
  dialogs.then(true);
  await reopen(page);
  await expect(message(page)).toHaveText("Labels restored.");
  expect(dialogs.log.at(-1)).toMatch(/^Restore labels saved .+ for rgb4326\.tif\?$/);
  expect(tileDiff(await effectiveTiles(page), a)).toEqual([]);
  expect(await roles(page)).toEqual({ current: counts.replaced, replaced: counts.current });
});

test("a third import with the replaced labels not exported is refused and changes no labels", async ({ page }) => {
  const dialogs = answer(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(/^Seeded /);
  dialogs.then(true); // the import saves the first mask's session before it replaces it (spec 075)
  await importFile(page, maskB());
  await expect(message(page)).toHaveText(/^Seeded /);
  await saved(page);
  const b = await effectiveTiles(page);
  const asked = dialogs.log.length;
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(MESSAGES.replacedFirst);
  expect(dialogs.log.length).toBe(asked); // refused before spec 017's confirm
  expect(tileDiff(await effectiveTiles(page), b)).toEqual([]);
});
