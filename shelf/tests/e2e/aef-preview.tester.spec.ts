import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { AefEntry } from "../../src/core/aef";
import { ATTRIBUTION, fetchChip, logRequests, serveAef } from "./aef";
import { holdCogs } from "./aefTester";
import { message, openApp, openRaster, rgbFixture } from "./helpers";

// Tester e2e for the AlphaEarth preview (spec 002 Scope, criteria 11 and 14): stacking across
// repeated opens and fetches, toggling, and the attribution while data is replaced.
const FIX = "tests/fixtures/aef";
const entries = JSON.parse(readFileSync(`${FIX}/aef-index/2021/32617.json`, "utf8")) as AefEntry[];
const file = (i: number) => ({ name: `aef${i}.tiff`, mimeType: "image/tiff", buffer: readFileSync(`${FIX}/cogs/${entries[i]!.path}`) });

const order = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.map((l: any) => l.id)
  .filter((id: string) => id === "aef-preview" || id === "preview" || id.startsWith("td-")));
const visibility = (page: Page, id: string) => page.evaluate((id) => (window as any).__geoapp.map.getLayoutProperty(id, "visibility") ?? "visible", id);

/** aef-preview first, then preview, then every terra-draw layer. */
function stacked(ids: string[]) {
  expect(ids.slice(0, 2)).toEqual(["aef-preview", "preview"]);
  expect(ids.slice(2).every((id) => id.startsWith("td-"))).toBe(true);
}

test("stacking holds over raster, fetch, raster again and fetch again; hiding AlphaEarth leaves local imagery shown", async ({ page }) => {
  await serveAef(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  stacked(await order(page));
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  stacked(await order(page));
  await page.click("#aef-fetch");
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  stacked(await order(page));
  await page.locator("#aef-preview").uncheck();
  expect(await visibility(page, "aef-preview")).toBe("none");
  expect(await visibility(page, "preview")).toBe("visible");
});

test("during a second fetch the old preview and attribution are gone and the toggle is off; afterwards both are back", async ({ page }) => {
  await serveAef(page);
  await openApp(page);
  await fetchChip(page);
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await page.locator("#aef-preview").uncheck();
  const gate = await holdCogs(page);
  await page.click("#aef-fetch");
  await expect(message(page)).toHaveText("Downloading embeddings...");
  await expect(page.getByText(ATTRIBUTION)).toBeHidden();
  await expect(page.locator("#aef-preview")).toBeDisabled();
  await expect(page.locator("#aef-preview")).not.toBeChecked();
  expect(await page.evaluate(() => Boolean((window as any).__geoapp.map.getLayer("aef-preview")))).toBe(false);
  gate.release();
  await expect(message(page)).toHaveText("Embeddings downloaded.");
  await expect(page.locator("#aef-preview")).toBeChecked();
  expect(await visibility(page, "aef-preview")).toBe("visible");
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();
});

test("a second AlphaEarth file replaces the first: preview shown again after it was hidden, attribution visible, no requests", async ({ page, baseURL }) => {
  await openApp(page);
  const log = logRequests(page);
  await page.setInputFiles("#open-aef", file(0));
  await expect(message(page)).toHaveText("AlphaEarth file opened.");
  await page.locator("#aef-preview").uncheck();
  await page.setInputFiles("#open-aef", file(1));
  await expect(message(page)).toHaveText("AlphaEarth file opened.");
  await expect(page.locator("#aef-preview")).toBeChecked();
  expect(await visibility(page, "aef-preview")).toBe("visible");
  await expect(page.getByText(ATTRIBUTION)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__geoapp.aef().aoi.width)).toBe((entries[1]!.x1 - entries[1]!.x0) / 10);
  expect(log.map((r) => r.url()).filter((u) => !u.startsWith("blob:") && !u.startsWith("data:") && !u.startsWith(`${baseURL}/assets/`))).toEqual([]);
});
