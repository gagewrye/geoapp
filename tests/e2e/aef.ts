import { readFileSync } from "node:fs";
import { expect, type Page, type Request } from "@playwright/test";
import { AEF_BASE, dequantize } from "../../src/core/aef";
import { toLonLat } from "../../src/core/crs";
import { clickAt, jumpTo, moveTo, toScreen, type LngLat } from "./helpers";

// Fixtures (a) and (b) of spec 002, served through Playwright routes: CI never touches the network.
const FIX = "tests/fixtures/aef";
export const HOST = new URL(AEF_BASE).host;
export const chip = JSON.parse(readFileSync(`${FIX}/ref_chip.json`, "utf8")) as { epsg: number; x0: number; y1: number; width: number; height: number };
const N = chip.width;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "*" };

/** dequantize of the reference chip, band-major [64][128][128] north-up. */
export function refChip(): Float32Array {
  const b = readFileSync(`${FIX}/ref_chip.i8`);
  const out = new Float32Array(b.length);
  dequantize(new Int8Array(b.buffer, b.byteOffset, b.length), out);
  return out;
}

/** A COG answer to override: an HTTP status, a network error, or a 206 without CORS headers. */
export type Fault = (url: string) => number | "network" | "nocors" | undefined;

/**
 * Serves the fixture COGs under AEF_BASE (206 for Range GETs, CORS as Source Cooperative sends it)
 * and the fixture index under the app's /aef-index/. Other shards are 404s.
 */
export async function serveAef(page: Page, fault: Fault = () => undefined): Promise<void> {
  await page.route(`${AEF_BASE}**`, async (route) => {
    const url = route.request().url();
    const f = fault(url);
    if (f === "network") return route.abort("failed");
    if (typeof f === "number") return route.fulfill({ status: f, headers: CORS, body: "error" });
    let data: Buffer;
    try { data = readFileSync(`${FIX}/cogs/${url.slice(AEF_BASE.length)}`); } catch { return route.fulfill({ status: 404, headers: CORS }); }
    const m = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? "");
    if (!m) return route.fulfill({ status: 200, headers: CORS, body: data });
    const a = Number(m[1]), b = Math.min(Number(m[2]), data.length - 1);
    const headers = { ...(f === "nocors" ? {} : CORS), "Content-Type": "image/tiff", "Content-Range": `bytes ${a}-${b}/${data.length}` };
    return route.fulfill({ status: 206, headers, body: data.subarray(a, b + 1) });
  });
  await page.route("**/aef-index/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/aef-index\//, "");
    try {
      return route.fulfill({ status: 200, contentType: "application/json", body: readFileSync(`${FIX}/aef-index/${path}`) });
    } catch {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    }
  });
}

/** Every request the page makes, with its method, headers and body. */
export function logRequests(page: Page): Request[] {
  const log: Request[] = [];
  page.on("request", (r) => log.push(r));
  return log;
}

export const cogRequests = (log: Request[]) => log.filter((r) => r.url().startsWith(AEF_BASE));

/** Lon/lat [w, s, e, n] around a UTM box, grown by `margin` metres. */
export function lonLatBox(epsg: number, [x0, y0, x1, y1]: number[], margin: number): number[] {
  const pts = [[x0! - margin, y0! - margin], [x1! + margin, y0! - margin], [x1! + margin, y1! + margin], [x0! - margin, y1! + margin]]
    .map(([x, y]) => toLonLat(epsg, x!, y!));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/** The fixture chip's UTM box [x0, y0, x1, y1]. */
export const chipBox = [chip.x0, chip.y1 - 10 * N, chip.x0 + 10 * N, chip.y1];
export const chipCentre = toLonLat(chip.epsg, chip.x0 + 5 * N, chip.y1 - 5 * N) as LngLat;

/** Draw the area rectangle from its north-west to its south-east corner. */
export async function drawArea(page: Page, [w, s, e, n]: number[]): Promise<void> {
  await page.click("#aef-draw");
  const a = await toScreen(page, [w!, n!]), b = await toScreen(page, [e!, s!]);
  await clickAt(page, a);
  await moveTo(page, a, b, 10);
  await clickAt(page, b);
}

/** View the chip at zoom 15, draw an area around it (30 m margin), and fetch `year`. */
export async function fetchChip(page: Page, year = "2021", box = lonLatBox(chip.epsg, chipBox, 30)): Promise<void> {
  await jumpTo(page, chipCentre, 15);
  await drawArea(page, box);
  await expect(page.locator("#aef-year option")).not.toHaveCount(0);
  await page.selectOption("#aef-year", year);
  await page.click("#aef-fetch");
}

/** Sizes of the files in the OPFS AlphaEarth cache folder, or null when it doesn't exist. */
export function cacheFiles(page: Page): Promise<Record<string, number> | null> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("aef-cache").catch(() => null);
    if (!dir) return null;
    const out: Record<string, number> = {};
    for await (const [name, h] of (dir as any).entries()) out[name] = (await (h as FileSystemFileHandle).getFile()).size;
    return out;
  });
}

export const ATTRIBUTION = "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.";

/**
 * Draw an accepted area (about 1.6 x 2.2 km) centred on `c`, zoomed in so it can be drawn, then
 * return to the earlier view: refused areas are removed (tester F3), so tests that just need an area draw this.
 */
export async function drawSmallArea(page: Page, c: LngLat): Promise<void> {
  const view = await page.evaluate(() => { const { map } = (window as any).__geoapp; const p = map.getCenter(); return { center: [p.lng, p.lat] as LngLat, zoom: map.getZoom() as number }; });
  await jumpTo(page, c, 12);
  await drawArea(page, [c[0] - 0.01, c[1] - 0.01, c[0] + 0.01, c[1] + 0.01]);
  await expect(page.locator("#aef-info")).toHaveText(/^Area: /);
  await jumpTo(page, view.center, view.zoom);
}
