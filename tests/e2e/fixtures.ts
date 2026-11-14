import type { Affine, Grid } from "../../src/core/types";
import { geotiffBuffer, type Value } from "../unit/helpers/sources";
import { tiledGeotiffBuffer } from "../unit/helpers/tiledTiff";

// E2e raster fixtures (spec 072): built once per worker, as Playwright upload payloads.

type LngLat = [number, number];

/** Fixture GeoTIFF as a Playwright upload payload. */
export function tiff(name: string, width: number, height: number, nb: number, f: Value, geo: { epsg: number; gt: Affine; nodata?: string }) {
  return { name, mimeType: "image/tiff", buffer: Buffer.from(geotiffBuffer(width, height, nb, f, geo)) };
}

/** A fixture built once per worker (spec 072: building one took 2-3 s on CI); each call returns a fresh payload around the same bytes. */
export function once(make: () => ReturnType<typeof tiff>): () => ReturnType<typeof tiff> {
  let made: ReturnType<typeof tiff> | null = null;
  return () => ({ ...(made ??= make()) });
}

/** Uint8 RGB in 256 px tiles on rgbFixture's 0.01 degree grid from 10E 50N (spec 072 step 0: the cheapest fixture that keeps the grid and the mask reads). */
const rgbTiles = (name: string, height: number, f: Value, nodata: string) => ({ name, mimeType: "image/tiff",
  buffer: Buffer.from(tiledGeotiffBuffer(1000, height, 3, f, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01], nodata }, { uint8: true })) });

/** 10x10 degree RGB raster at 10..20E, 40..50N; a white block marks 15.5E 45.5N. */
const FEATURE: LngLat = [15.5, 45.5];
const rgbValue: Value = (b, c, r) => {
  const lon = 10 + (c + 0.5) * 0.01, lat = 50 - (r + 0.5) * 0.01;
  if (Math.abs(lon - FEATURE[0]) < 0.05 && Math.abs(lat - FEATURE[1]) < 0.05) return 255;
  return b === 0 ? (c < 500 ? 200 : 120) : b === 1 ? 100 + (r % 100) : 150;
};
/** GDAL_NODATA 0, which no pixel holds, so its masks are read (spec 023) as the Float32 strip's were. */
export const rgbFixture = once(() => rgbTiles("rgb4326.tif", 1000, rgbValue, "0"));
/** rgbFixture as the Float32 single strip it was before spec 072: its open reads through geotiff.js's decoders, so they are loaded before any label import. */
export const rgbStrip = once(() => tiff("rgb4326.tif", 1000, 1000, 3, rgbValue, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }));
/** rgbFixture run on south to 37N, with a nodata value none of its pixels hold: its 6 row bands need mask reads (spec 023 F2), and band 4 lies far from paintTwoClasses' hovers. */
export const rgbNodataFixture = once(() => rgbTiles("rgbtall.tif", 1300, rgbValue, "0"));
/** rgbFixture with 16 more bytes at its end: the same grid and pixels, but another raster to spec 031, so it offers no saved labels. */
export const anotherRaster = (name = "other.tif") => { const f = rgbFixture(); return { ...f, name, buffer: Buffer.concat([f.buffer, Buffer.alloc(16)]) }; };


/** rgbFixture's grid. */
export const RGB_GRID: Grid = { width: 1000, height: 1000, epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] };
