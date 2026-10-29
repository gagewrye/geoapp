import { expect, type CDPSession, type Page, type Request } from "@playwright/test";
import { geotiffBuffer, type Value } from "../unit/helpers/sources";
import type { Affine, Grid } from "../../src/core/types";

export type LngLat = [number, number];
export type Ring = LngLat[];
export type Xy = { x: number; y: number };

/** Fixture GeoTIFF as a Playwright upload payload. */
export function tiff(name: string, width: number, height: number, nb: number, f: Value, geo: { epsg: number; gt: Affine; nodata?: string }) {
  return { name, mimeType: "image/tiff", buffer: Buffer.from(geotiffBuffer(width, height, nb, f, geo)) };
}

/** 10x10 degree RGB raster at 10..20E, 40..50N; a white block marks 15.5E 45.5N. */
export const FEATURE: LngLat = [15.5, 45.5];
export const rgbFixture = () => tiff("rgb4326.tif", 1000, 1000, 3, (b, c, r) => {
  const lon = 10 + (c + 0.5) * 0.01, lat = 50 - (r + 0.5) * 0.01;
  if (Math.abs(lon - FEATURE[0]) < 0.05 && Math.abs(lat - FEATURE[1]) < 0.05) return 255;
  return b === 0 ? (c < 500 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150;
}, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] });

export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#map[data-ready=true]")).toBeVisible();
}

/** src/map/style.ts BACKGROUND; that module imports a Vite `?url` asset, which Playwright can't load. */
export const BACKGROUND = "#1d2b3a";

/** Hide the basemap through the test hook, so map pixels can be compared with BACKGROUND (spec 012 Tests). */
export async function hideBasemap(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { map } = (window as any).__geoapp;
    map.setLayoutProperty("basemap", "visibility", "none");
    await new Promise<void>((r) => { map.once("idle", () => r()); map.triggerRepaint(); });
  });
}

export async function openRaster(page: Page, file: ReturnType<typeof tiff>): Promise<void> {
  await page.setInputFiles("#open-raster", file);
}

/** Jump without animation and wait until the map has finished rendering. */
export async function jumpTo(page: Page, center: LngLat, zoom: number): Promise<void> {
  await page.evaluate(async ([center, zoom]) => {
    const { map } = (window as any).__geoapp;
    map.jumpTo({ center, zoom });
    await new Promise<void>((r) => { map.once("idle", () => r()); map.triggerRepaint(); });
  }, [center, zoom] as const);
}

/** Page coordinates of a lon/lat. */
export async function toScreen(page: Page, p: LngLat): Promise<Xy> {
  return page.evaluate((p) => {
    const { map } = (window as any).__geoapp;
    const { x, y } = map.project(p);
    const r = map.getCanvas().getBoundingClientRect();
    return { x: r.left + x, y: r.top + y };
  }, p);
}

/** Unprojected lon/lat of page coordinates. */
export async function toLngLat(page: Page, pts: Xy[]): Promise<LngLat[]> {
  return page.evaluate((pts) => {
    const { map } = (window as any).__geoapp;
    const r = map.getCanvas().getBoundingClientRect();
    return pts.map((p) => { const ll = map.unproject([p.x - r.left, p.y - r.top]); return [ll.lng, ll.lat] as [number, number]; });
  }, pts);
}

/** RGBA of the rendered canvas at a page point, read inside a render frame. */
export async function pixelAt(page: Page, p: Xy): Promise<number[]> {
  return page.evaluate(async (p) => {
    const { map } = (window as any).__geoapp;
    const canvas: HTMLCanvasElement = map.getCanvas();
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    return new Promise<number[]>((resolve) => {
      map.once("render", () => {
        const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
        const px = new Uint8Array(4);
        gl.readPixels(Math.round((p.x - r.left) * sx), Math.round(canvas.height - (p.y - r.top) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        resolve(Array.from(px));
      });
      map.triggerRepaint();
    });
  }, p);
}

export async function clickAt(page: Page, p: Xy): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
}

export async function dragFromTo(page: Page, a: Xy, b: Xy): Promise<void> {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(80);
}

/** Longitude difference reduced to (-180, 180]. */
export const lonDiff = (a: number, b: number) => { const d = (((a - b) % 360) + 540) % 360 - 180; return d === -180 ? 180 : d; };

export const message = (page: Page) => page.locator("#message");

export const lerp = (a: Xy, b: Xy, t: number): Xy => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export const dragPanEnabled = (page: Page) => page.evaluate(() => (window as any).__geoapp.map.dragPan.isEnabled() as boolean);

/** Uncaught page errors, collected from now on. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Mouse path a -> b in `steps` moves, button state unchanged. */
export async function moveTo(page: Page, a: Xy, b: Xy, steps = 20): Promise<void> {
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
}

/** Raw CDP touch: each point is [id, xy]; an empty list ends (or cancels) every touch. */
export function toucher(cdp: CDPSession) {
  return (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", pts: [number, Xy][] = []) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([id, p]) => ({ id, x: p.x, y: p.y })) });
}

/**
 * Raw CDP mouse or pen, so coordinates may lie outside the viewport. `held` false sends buttons 0
 * (a lost release when no mouseReleased came). A pen's barrel button is "right".
 */
export function rawPointer(cdp: CDPSession, pointerType: "mouse" | "pen" = "mouse", button: "left" | "right" = "left") {
  return (type: "mousePressed" | "mouseMoved" | "mouseReleased", p: Xy, held: boolean) =>
    cdp.send("Input.dispatchMouseEvent", {
      type, x: p.x, y: p.y, pointerType,
      button: type === "mouseMoved" && !held ? "none" : button, buttons: held ? (button === "left" ? 1 : 2) : 0, clickCount: type === "mouseMoved" ? 0 : 1,
    });
}

/** rgbFixture's grid. */
export const RGB_GRID: Grid = { width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] };

/** Stored labels through the e2e hook, as "col,row" -> value (non-zero only). */
export async function labels(page: Page): Promise<Map<string, number>> {
  const flat: number[] = await page.evaluate(() => {
    const { store } = (window as any).__geoapp.labels;
    const out: number[] = [];
    for (const [key, t] of store.tiles as Map<string, Uint8Array>) {
      const [x0, y0] = key.split(",").map(Number) as [number, number];
      const w = Math.min(256, store.width - x0);
      t.forEach((v, i) => { if (v) out.push(x0 + (i % w), y0 + Math.floor(i / w), v); });
    }
    return out;
  });
  const m = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 3) m.set(`${flat[i]},${flat[i + 1]}`, flat[i + 2]!);
  return m;
}

/** Keys of the stored label tiles. */
export const tileKeysStored = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as any).__geoapp.labels.store.tiles.keys()].sort());

/** Wait until strokes waiting for nodata masks have applied (Import labels is disabled meanwhile). */
export const settled = (page: Page) => expect(page.locator("#import-labels")).toBeEnabled();

/** Every request the page makes from now on. */
export function logRequests(page: Page): Request[] {
  const log: Request[] = [];
  page.on("request", (r) => log.push(r));
  return log;
}

/** Mouse stroke through the points with one button held, then released, and settled. */
export async function stroke(page: Page, pts: Xy[], button: "left" | "right" = "left"): Promise<void> {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down({ button });
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up({ button });
  await settled(page);
}

/** n evenly spaced points from a to b, both included. */
export const path = (a: Xy, b: Xy, n: number): Xy[] => Array.from({ length: n }, (_, i) => lerp(a, b, n === 1 ? 0 : i / (n - 1)));

/** The view, to check that painting moved nothing. */
export const view = (page: Page) => page.evaluate(() => {
  const { map } = (window as any).__geoapp;
  const c = map.getCenter();
  return { lng: c.lng as number, lat: c.lat as number, zoom: map.getZoom() as number, bearing: map.getBearing() as number, pitch: map.getPitch() as number };
});

/** The brush hover feature collection (empty when there is no hover source yet). */
export const hoverFeatures = (page: Page): Promise<any[]> => page.evaluate(async () => {
  const s = (window as any).__geoapp.map.getSource("brush-hover");
  return s ? ((await s.getData()) as any).features : [];
});

/** Choose the class at a 0-based index by clicking its row. */
export const selectClass = (page: Page, i: number) => page.locator("#classes li").nth(i).click({ position: { x: 4, y: 4 } });

/** Rename class i in the class list (Enter commits). */
export async function renameClass(page: Page, i: number, name: string): Promise<void> {
  const field = page.locator("#classes .class-name").nth(i);
  await field.fill(name);
  await field.press("Enter");
}

/**
 * On rgbFixture: name classes 1 and 2, then paint class 1 west (band 1 = 200) and class 2 east
 * (band 1 = 120) of 15E by mouse, at zoom 6 around 15E 45N.
 */
export async function paintTwoClasses(page: Page, names = ["left", "right"]): Promise<void> {
  for (const [i, n] of names.entries()) await renameClass(page, i, n);
  await jumpTo(page, [15, 45], 6);
  for (const [i, lon] of [12.005, 18.005].entries()) {
    await selectClass(page, i);
    const a = await toScreen(page, [lon, 45.005]);
    await stroke(page, [a, { x: a.x + 30, y: a.y + 20 }, { x: a.x + 60, y: a.y }]);
  }
}
