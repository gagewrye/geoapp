import { expect, type CDPSession, type Page } from "@playwright/test";
import { geotiffBuffer, type Value } from "../unit/helpers/sources";
import { checkRing, normalizeLon } from "../../src/core/ring";
import type { Affine } from "../../src/core/types";

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

export async function snapshot(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__geoapp.draw.getSnapshot().filter((f: any) => f.geometry.type === "Polygon"));
}

/** Polygons rendered by terra-draw layers, as returned by queryRenderedFeatures. */
export async function renderedPolygons(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    const { map } = (window as any).__geoapp;
    const layers = map.getStyle().layers.filter((l: any) => l.id.startsWith("td-") && l.type === "fill").map((l: any) => l.id);
    return map.queryRenderedFeatures({ layers }).filter((f: any) => f.geometry.type === "Polygon").map((f: any) => ({ coordinates: f.geometry.coordinates }));
  });
}

export async function setMode(page: Page, mode: "draw" | "select"): Promise<void> {
  await page.click(mode === "draw" ? "#mode-draw" : "#mode-select");
}

/** Click vertices in polygon mode, then click the first one again to close. */
export async function drawPolygon(page: Page, pts: Xy[], className?: string): Promise<void> {
  if (className !== undefined) await page.fill("#class-name", className);
  await setMode(page, "draw");
  for (const p of pts) await clickAt(page, p);
  await clickAt(page, pts[0]!);
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

/** Drag with one large move then a 1 px nudge, so terra-draw sees a single drag update at b. */
export async function jumpDrag(page: Page, a: Xy, b: Xy): Promise<void> {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y);
  await page.mouse.move(b.x + 1, b.y);
  await page.mouse.up();
  await page.waitForTimeout(80);
}

/** Longitude difference reduced to (-180, 180]. */
export const lonDiff = (a: number, b: number) => { const d = (((a - b) % 360) + 540) % 360 - 180; return d === -180 ? 180 : d; };

export const message = (page: Page) => page.locator("#message");

/** Outer rings of the stored polygons. */
export const rings = async (page: Page): Promise<Ring[]> => (await snapshot(page)).map((f) => f.geometry.coordinates[0]);

/** A ring that checkRing accepts, after wrapping longitudes. */
export const valid = (r: Ring) => checkRing(r.map(([x, y]) => [normalizeLon(x), y])) === null;

/** Nothing invalid is stored or rendered. */
export async function expectNothingInvalid(page: Page): Promise<void> {
  for (const r of await rings(page)) expect(valid(r), JSON.stringify(r)).toBe(true);
  for (const f of await renderedPolygons(page)) for (const r of f.coordinates) expect(valid(r), JSON.stringify(r)).toBe(true);
}

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
 * (a lost release when no mouseReleased came).
 */
export function rawPointer(cdp: CDPSession, pointerType: "mouse" | "pen" = "mouse") {
  return (type: "mousePressed" | "mouseMoved" | "mouseReleased", p: Xy, held: boolean) =>
    cdp.send("Input.dispatchMouseEvent", {
      type, x: p.x, y: p.y, pointerType,
      button: type === "mouseMoved" && !held ? "none" : "left", buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
    });
}

/** Large polar polygon whose body point is > 40 px (terra-draw's grab distance) from every handle. */
export const polar: Ring = [[-40, 60], [40, 60], [40, 82], [-40, 82]];
export const polarBody: LngLat = [0, 72];
export const polarVertex: LngLat = [40, 82];

/** Draw `polar` on the globe near the north pole and select it. */
export async function polarSetup(page: Page): Promise<void> {
  await openApp(page);
  await jumpTo(page, [0, 75], 1.5);
  await drawPolygon(page, await Promise.all(polar.map((p) => toScreen(page, p))), "ice");
  await setMode(page, "select");
  await clickAt(page, await toScreen(page, polarBody));
}

/** A valid polygon just west of 180 at the current view, selected in select mode; returns its screen corners and body. */
export async function westOf180(page: Page): Promise<{ c: Xy; pts: Xy[]; body: Xy }> {
  const c = await toScreen(page, [180, 0]);
  const pts = [{ x: c.x - 200, y: c.y - 80 }, { x: c.x - 30, y: c.y - 80 }, { x: c.x - 30, y: c.y + 80 }, { x: c.x - 200, y: c.y + 80 }];
  await drawPolygon(page, pts, "a");
  await setMode(page, "select");
  const body = { x: c.x - 115, y: c.y };
  await clickAt(page, body);
  return { c, pts, body };
}
