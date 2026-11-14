import { expect, type Page, type Request } from "@playwright/test";
import { geotiffBuffer, type Value } from "../unit/helpers/sources";
import type { Affine, Grid } from "../../src/core/types";
import { SHORTCUTS } from "../../src/ui/shortcuts";

export type LngLat = [number, number];
export type Xy = { x: number; y: number };

/** The hint line SHORTCUTS gives a button's title (spec 057). */
export const hintOf = (id: string) => SHORTCUTS.find((s) => s.id === id)!.hint!;

/** Fixture GeoTIFF as a Playwright upload payload. */
export function tiff(name: string, width: number, height: number, nb: number, f: Value, geo: { epsg: number; gt: Affine; nodata?: string }) {
  return { name, mimeType: "image/tiff", buffer: Buffer.from(geotiffBuffer(width, height, nb, f, geo)) };
}

/** 10x10 degree RGB raster at 10..20E, 40..50N; a white block marks 15.5E 45.5N. */
const FEATURE: LngLat = [15.5, 45.5];
const rgbValue: Value = (b, c, r) => {
  const lon = 10 + (c + 0.5) * 0.01, lat = 50 - (r + 0.5) * 0.01;
  if (Math.abs(lon - FEATURE[0]) < 0.05 && Math.abs(lat - FEATURE[1]) < 0.05) return 255;
  return b === 0 ? (c < 500 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150;
};
export const rgbFixture = () => tiff("rgb4326.tif", 1000, 1000, 3, rgbValue, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] });
/** rgbFixture run on south to 37N (still one strip under the 16 MiB block limit), with a nodata value none of its pixels hold: its 6 row bands need mask reads (spec 023 F2), and band 4 lies far from paintTwoClasses' hovers. */
export const rgbNodataFixture = () => tiff("rgbtall.tif", 1000, 1300, 3, rgbValue, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01], nodata: "0" });
/** rgbFixture with 16 more bytes at its end: the same grid and pixels, but another raster to spec 031, so it offers no saved labels. */
export const anotherRaster = (name = "other.tif") => { const f = rgbFixture(); return { ...f, name, buffer: Buffer.concat([f.buffer, Buffer.alloc(16)]) }; };

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

/** Hide the preview and every full-resolution imagery tile (spec 020), including tiles added later, so unpainted space shows what lies below. */
export async function hideImagery(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { map } = (window as any).__geoapp;
    for (const id of map.getLayersOrder() as string[]) if (id === "preview" || id.startsWith("imagery-")) map.setLayoutProperty(id, "visibility", "none");
    if (map.__imageryHidden) return;
    map.__imageryHidden = true;
    const add = map.addLayer.bind(map);
    map.addLayer = (l: { id: string; layout?: object }, before?: string) =>
      add(l.id.startsWith("imagery-") ? { ...l, layout: { ...l.layout, visibility: "none" } } : l, before);
  });
}

/** Resolves once no label-overlay redraw is scheduled and no quads are queued (spec 071). */
export const overlaysIdle = (page: Page): Promise<void> => page.evaluate(() => (window as any).__geoapp.overlaysIdle());

/** Waits for the map's next idle. */
export const mapIdle = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((r) => {
  const { map } = (window as any).__geoapp;
  map.once("idle", () => r());
  map.triggerRepaint();
}));

/** Tile keys of the `label-` overlay layers on the map, sorted. */
export const overlayKeysShown = (page: Page): Promise<string[]> => page.evaluate(() =>
  [...new Set(((window as any).__geoapp.map.getLayersOrder() as string[]).flatMap((id) => /^label-(\d+,\d+)/.exec(id)?.[1] ?? []))].sort());

/** Select Paint: an open or a successful import selects Pan (spec 016 Tests), so tests that paint after one call this. */
export async function paintMode(page: Page): Promise<void> {
  await page.click("#mode-paint");
  await expect(page.locator("#mode-paint")).toHaveAttribute("aria-pressed", "true");
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
        gl.readPixels(Math.floor((p.x - r.left) * sx), canvas.height - 1 - Math.floor((p.y - r.top) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
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

export const message = (page: Page) => page.locator("#message");

const lerp = (a: Xy, b: Xy, t: number): Xy => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });


/** Uncaught page errors, collected from now on. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** rgbFixture's grid. */
export const RGB_GRID: Grid = { width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] };

/** Effective labels through the e2e hook (stored tiles, else the mask's: spec 014's tile(key)), as "col,row" -> value (non-zero only). */
export async function labels(page: Page): Promise<Map<string, number>> {
  const flat: number[] = await page.evaluate(async () => {
    const { store, tile } = (window as any).__geoapp.labels;
    const out: number[] = [];
    for (let y0 = 0; y0 < store.height; y0 += 256) for (let x0 = 0; x0 < store.width; x0 += 256) {
      const t: Uint8Array | null = await tile(`${x0},${y0}`);
      const w = Math.min(256, store.width - x0);
      t?.forEach((v, i) => { if (v) out.push(x0 + (i % w), y0 + Math.floor(i / w), v); });
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

/** Opens class i's rename field with its button (spec 036) and returns the field, focused. */
export async function editName(page: Page, i: number) {
  await page.locator("#classes li").nth(i).locator(".class-rename").click();
  const field = page.locator("#classes .class-name-edit");
  await expect(field).toBeFocused();
  return field;
}

/** Rename class i in the class list (Enter commits). */
export async function renameClass(page: Page, i: number, name: string): Promise<void> {
  const field = await editName(page, i);
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
