import { expect, test, type Page } from "@playwright/test";
import type { Affine } from "../../src/core/types";
import { uint8Tiff } from "../unit/helpers/tiffFixtures";
import { holdKeys, jumpTo, message, openApp, openRaster, toScreen, type LngLat } from "./helpers";

// Spec 027 criterion 3: after a held D the visible full-resolution tiles are drawn once it is released, and none load mid-pan
// (spec 060 dropped the 1 s bound: it measured the machine).
const GT: Affine = [10, 0.0001, 0, 45.1, 0, -0.0001];
/** A checkerboard the 1024 px preview can't show: only full-resolution tiles draw its checks. Two 8 px blocks hold 0 and 255, so the stretch is 0..255. */
const check = (k: number, c: number, r: number) => (r < 8 && c < 16 ? (c < 8 ? 0 : 255) : (c + r) % 2 === 1 ? [230, 120, 60][k]! : [30, 40, 180][k]!);
const checkerboard = () => ({ name: "check.tif", mimeType: "image/tiff",
  buffer: Buffer.from(uint8Tiff([{ width: 3000, height: 1500, bands: 3, value: check, layout: { tile: [256, 256] } }], { epsg: 4326, gt: GT })) });
const lonLat = (c: number, r: number): LngLat => [GT[0] + GT[1] * c, GT[3] + GT[5] * r];
const imagerySources = (page: Page) => page.evaluate(() => Object.keys((window as any).__geoapp.map.getStyle().sources).filter((id) => id.startsWith("imagery-")).length);

/** Source pixels whose centres show the wrong colour, over a grid across the visible map. */
const wrongPixels = (page: Page) => page.evaluate(async () => {
  const { map } = (window as any).__geoapp;
  const canvas: HTMLCanvasElement = map.getCanvas();
  const px = await new Promise<{ w: number; h: number; buf: Uint8Array; scale: number }>((resolve) => {
    map.once("render", () => {
      const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
      const w = canvas.width, h = canvas.height, buf = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      resolve({ w, h, buf, scale: w / canvas.getBoundingClientRect().width });
    });
    map.triggerRepaint();
  });
  const rect = canvas.getBoundingClientRect();
  let wrong = 0;
  for (let i = 1; i < 8; i++) for (let j = 1; j < 6; j++) {
    const ll = map.unproject([(rect.width * i) / 8, (rect.height * j) / 6]);
    const c = Math.floor((ll.lng - 10) / 0.0001), r = Math.floor((45.1 - ll.lat) / 0.0001);
    const at = map.project([10 + (c + 0.5) * 0.0001, 45.1 - (r + 0.5) * 0.0001]);
    const x = Math.floor(at.x * px.scale), y = px.h - 1 - Math.floor(at.y * px.scale);
    const odd = (c + r) % 2 === 1, want = odd ? [230, 120, 60] : [30, 40, 180];
    if (want.some((v, k) => Math.abs(px.buf[4 * (y * px.w + x) + k]! - v) > 1)) wrong++;
  }
  return wrong;
});

test("after a 1 s held D at full resolution the visible tiles are drawn after release, and none load mid-pan (criterion 3)", async ({ page }) => {
  await openApp(page);
  await openRaster(page, checkerboard());
  await expect(message(page)).toHaveText("Raster opened.");
  // one source pixel is 4 CSS px, so the 600 px/s pan crosses 150 source px and new tiles
  await jumpTo(page, lonLat(600, 750), 14);
  const [a, b] = [await toScreen(page, lonLat(600, 750)), await toScreen(page, lonLat(601, 750))];
  await jumpTo(page, lonLat(600, 750), 14 + Math.log2(4 / Math.hypot(b.x - a.x, b.y - a.y)));
  await expect.poll(() => wrongPixels(page), { timeout: 20_000 }).toBe(0);
  const before = await imagerySources(page);
  await page.locator("#map canvas").first().focus().catch(() => {});
  // 20 frames that moved, so the pan reaches undrawn ground at any frame rate (spec 060 criterion 14)
  await holdKeys(page, ["KeyD"], { ms: 1000, frames: 20, beforeUp: async () => {
    expect(await imagerySources(page)).toBe(before); // nothing loads mid-pan
    expect(await wrongPixels(page)).toBeGreaterThan(0); // the pan reached space the tiles drawn before don't cover
  } });
  await expect.poll(() => wrongPixels(page), { intervals: [50] }).toBe(0);
});
